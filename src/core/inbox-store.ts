/**
 * Durable inbox state — the authored layer of ADR 0013 (dispositions, done,
 * provenance links) plus an event log, in SQLite via bun:sqlite (no new deps).
 *
 * Why a database where the rest of CSM uses files: the inbox is the one
 * domain with genuinely concurrent read-modify-write over SHARED rows — N
 * sidebar panes, the activity refresher, CLI verbs and eventually the bridge
 * all mutate the same disposition. The per-file-per-key pattern (verdicts/,
 * panes/) solves single-fact races but not transactions; the prototype's
 * shared-JSON state needed an in-process serialization chain and still had a
 * lost-write window between processes. WAL + busy_timeout is the textbook
 * answer for local multi-process state.
 *
 * The event log is load-bearing, not telemetry: transition-gated "Needs you"
 * (only observed events admit a row) and Claude0 stats ("cleared today",
 * inbox-zero streaks) both need history, which a snapshot file overwrites.
 *
 * What stays OUT: current activity (status, ages, PR cache) is derived state
 * owned by whoever computes it — it lives in the `snapshot` table as opaque
 * JSON per session, replaced wholesale each refresh. This store never
 * interprets it; schema churn there must not mean migrations here.
 */
import { Database } from "bun:sqlite";
import { PATHS } from "./config";

export type DispositionKind = "snoozed" | "blocked";

export interface DispositionRow {
  sessionId: string;
  kind: DispositionKind;
  /** Wake timestamp (ms) — snoozed only. */
  until: number | null;
  /** Free text — blocked only. Future: may hold a session ref (ADR 0013). */
  note: string | null;
  createdAt: number;
  /** A woken snooze already auto-reopened its pane — never spawn twice. */
  autoResumed: boolean;
}

export interface InboxEvent {
  id: number;
  sessionId: string;
  at: number;
  type: string;
  meta: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dispositions(
  session_id   TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK(kind IN ('snoozed','blocked')),
  until        INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  auto_resumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS archived(
  session_id  TEXT PRIMARY KEY,
  archived_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);
CREATE TABLE IF NOT EXISTS links(
  child_id   TEXT PRIMARY KEY,
  parent_id  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('fork','handoff')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot(
  session_id TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class InboxStore {
  readonly db: Database;

  constructor(path: string = `${PATHS.dir}/inbox.db`) {
    this.db = new Database(path, { create: true });
    // WAL: concurrent readers + one writer; busy_timeout instead of SQLITE_BUSY
    // throws when the refresher's write overlaps a verb.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * PRAGMA data_version: bumps when ANOTHER connection commits — a free
   * change-poll for long-lived readers (own writes refresh explicitly).
   */
  dataVersion(): number {
    return (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  private event(sessionId: string, at: number, type: string, meta?: unknown): void {
    this.db
      .query("INSERT INTO events(session_id, at, type, meta) VALUES (?, ?, ?, ?)")
      .run(sessionId, at, type, meta === undefined ? null : JSON.stringify(meta));
  }

  // ── verbs (each refuses invalid targets, mirrors ADR semantics) ──────────

  /** Park until `until`. Re-snoozing re-arms the wake auto-reopen. */
  snooze(sessionId: string, until: number, now: number): boolean {
    return this.db.transaction(() => {
      if (this.isArchived(sessionId)) return false;
      this.db
        .query(
          `INSERT INTO dispositions(session_id, kind, until, note, created_at, auto_resumed)
           VALUES (?, 'snoozed', ?, NULL, ?, 0)
           ON CONFLICT(session_id) DO UPDATE SET
             kind='snoozed', until=excluded.until, note=NULL,
             created_at=excluded.created_at, auto_resumed=0`,
        )
        .run(sessionId, until, now);
      this.event(sessionId, now, "snooze", { until });
      return true;
    })();
  }

  block(sessionId: string, note: string, now: number): boolean {
    return this.db.transaction(() => {
      if (this.isArchived(sessionId)) return false;
      this.db
        .query(
          `INSERT INTO dispositions(session_id, kind, until, note, created_at, auto_resumed)
           VALUES (?, 'blocked', NULL, ?, ?, 0)
           ON CONFLICT(session_id) DO UPDATE SET
             kind='blocked', until=NULL, note=excluded.note,
             created_at=excluded.created_at, auto_resumed=0`,
        )
        .run(sessionId, note, now);
      this.event(sessionId, now, "block", { note });
      return true;
    })();
  }

  /**
   * Drop the disposition (reply observed, or explicit unpark). Returns the
   * kind it had, so callers can mark "woken from snooze" — or null if none.
   */
  clearDisposition(sessionId: string, now: number, reason: string): DispositionKind | null {
    return this.db.transaction(() => {
      const prev = this.db
        .query("SELECT kind FROM dispositions WHERE session_id = ?")
        .get(sessionId) as { kind: DispositionKind } | null;
      if (!prev) return null;
      this.db.query("DELETE FROM dispositions WHERE session_id = ?").run(sessionId);
      this.event(sessionId, now, "unpark", { reason, was: prev.kind });
      return prev.kind;
    })();
  }

  /** Done. Clears any disposition; idempotent-refuses a second archive. */
  archive(sessionId: string, now: number): boolean {
    return this.db.transaction(() => {
      if (this.isArchived(sessionId)) return false;
      this.db.query("DELETE FROM dispositions WHERE session_id = ?").run(sessionId);
      this.db.query("INSERT INTO archived(session_id, archived_at) VALUES (?, ?)").run(sessionId, now);
      this.event(sessionId, now, "archive");
      return true;
    })();
  }

  /** Undo done — back to Needs you (pane resurrection is NOT this store's job). */
  unarchive(sessionId: string, now: number): boolean {
    return this.db.transaction(() => {
      const hit = this.db.query("DELETE FROM archived WHERE session_id = ? RETURNING session_id").get(sessionId);
      if (!hit) return false;
      this.event(sessionId, now, "unarchive");
      return true;
    })();
  }

  /** The wake auto-reopen fired for this snooze stretch. */
  markAutoResumed(sessionId: string, now: number): void {
    this.db
      .query("UPDATE dispositions SET auto_resumed = 1 WHERE session_id = ? AND kind = 'snoozed'")
      .run(sessionId);
    this.event(sessionId, now, "auto_resume");
  }

  // ── reads ────────────────────────────────────────────────────────────────

  isArchived(sessionId: string): boolean {
    return !!this.db.query("SELECT 1 FROM archived WHERE session_id = ?").get(sessionId);
  }

  dispositions(): Map<string, DispositionRow> {
    const rows = this.db
      .query("SELECT session_id, kind, until, note, created_at, auto_resumed FROM dispositions")
      .all() as Array<{
      session_id: string;
      kind: DispositionKind;
      until: number | null;
      note: string | null;
      created_at: number;
      auto_resumed: number;
    }>;
    return new Map(
      rows.map((r) => [
        r.session_id,
        {
          sessionId: r.session_id,
          kind: r.kind,
          until: r.until,
          note: r.note,
          createdAt: r.created_at,
          autoResumed: !!r.auto_resumed,
        },
      ]),
    );
  }

  /** sessionId → archivedAt. Full history; callers window it (24h = RECENT). */
  archivedAt(): Map<string, number> {
    const rows = this.db.query("SELECT session_id, archived_at FROM archived").all() as Array<{
      session_id: string;
      archived_at: number;
    }>;
    return new Map(rows.map((r) => [r.session_id, r.archived_at]));
  }

  events(sessionId?: string, limit = 100): InboxEvent[] {
    const rows = (
      sessionId
        ? this.db.query("SELECT * FROM events WHERE session_id = ? ORDER BY at DESC, id DESC LIMIT ?").all(sessionId, limit)
        : this.db.query("SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?").all(limit)
    ) as Array<{ id: number; session_id: string; at: number; type: string; meta: string | null }>;
    return rows.map((r) => ({ id: r.id, sessionId: r.session_id, at: r.at, type: r.type, meta: r.meta }));
  }

  // ── provenance (forward-compat, ADR 0013 follow-up) ──────────────────────

  link(childId: string, parentId: string, kind: "fork" | "handoff", now: number): void {
    this.db
      .query(
        `INSERT INTO links(child_id, parent_id, kind, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(child_id) DO NOTHING`,
      )
      .run(childId, parentId, kind, now);
  }

  parentOf(childId: string): { parentId: string; kind: "fork" | "handoff" } | null {
    const r = this.db.query("SELECT parent_id, kind FROM links WHERE child_id = ?").get(childId) as
      | { parent_id: string; kind: "fork" | "handoff" }
      | null;
    return r ? { parentId: r.parent_id, kind: r.kind } : null;
  }

  // ── snapshot (opaque derived-activity cache, replaced wholesale) ─────────

  saveSnapshot(rows: Array<{ sessionId: string; data: string }>, now: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM snapshot").run();
      const ins = this.db.query("INSERT INTO snapshot(session_id, data, updated_at) VALUES (?, ?, ?)");
      for (const r of rows) ins.run(r.sessionId, r.data, now);
    })();
  }

  loadSnapshot(): Array<{ sessionId: string; data: string; updatedAt: number }> {
    const rows = this.db.query("SELECT session_id, data, updated_at FROM snapshot").all() as Array<{
      session_id: string;
      data: string;
      updated_at: number;
    }>;
    return rows.map((r) => ({ sessionId: r.session_id, data: r.data, updatedAt: r.updated_at }));
  }

  // ── kv (tiny shared prefs, e.g. parked-expanded) ─────────────────────────

  getKV(key: string): string | null {
    const r = this.db.query("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }

  setKV(key: string, value: string): void {
    this.db
      .query("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  /** Wipe everything — seed/test helper, never called in normal operation. */
  reset(): void {
    this.db.exec("DELETE FROM dispositions; DELETE FROM archived; DELETE FROM events; DELETE FROM snapshot; DELETE FROM kv;");
  }
}
