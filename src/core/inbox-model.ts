// Pure inbox lifecycle math (ADR 0013), shared by every surface that sets or
// interprets inbox state — wake daemon, sidebar renderer, CLI verbs. No IO.
// Authored facts live in InboxStore; activity rows come from the discovery
// snapshot; everything time-driven (a wake coming due, a done row expiring)
// is DERIVED here at read time from timestamps, so concurrent renderers
// never race to write transitions.

export type Disposition =
  | { kind: "snoozed"; until: number } // ms timestamp; day snoozes land on local midnight
  | { kind: "blocked"; note: string };

export interface InboxSession {
  id: string;
  repo: string;
  name: string;
  reason: "question" | "approval" | "turn-done";
  approvalTool?: string;
  /** When it entered its current activity state. */
  since: number;
  running?: { finishAt: number };
  disposition?: Disposition;
  archivedAt?: number;
  fromSnooze?: boolean;
  /** Present on rows backed by a live pane — Enter switches to it. */
  real?: { paneId: string; target: string; status: "running" | "waiting" | "ready" };
  /** Where the session lives on disk — resume-on-demand runs `claude -r` here. */
  repoPath?: string;
  branch?: string;
  /** A woken snooze already auto-reopened its pane — never spawn twice. */
  autoResumed?: boolean;
  /** Turn is over but a live run_in_background script is still going (the ⏳ tier). */
  script?: boolean;
  /** When the script-wait state began (⧗ rows age from this, not the prompt). */
  scriptSince?: number;
  /** Branch PR, refreshed lazily by discovery (number absent = no PR). */
  pr?: { number?: number; state: string; fetchedAt: number };
}

export type Section = "needs-you" | "running" | "parked" | "done";

// LOCAL dates, not UTC — with ISO slicing a "snooze 1d" pressed at 00:30 local
// wakes ~90 minutes later (UTC midnight = 02:00 CEST). Day granularity means
// the user's day, so all day math uses local calendar components.
function localYMD(t: number): string {
  const dt = new Date(t);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

export function addDays(now: number, days: number): string {
  return localYMD(now + days * 86_400_000);
}

/** Local midnight of a YYYY-MM-DD (new Date("YYYY-MM-DD") would be UTC). */
export function localMidnight(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

/** Wake timestamp for a snooze: hours are exact, days land on local midnight. */
export function wakeAt(now: number, n: number, unit: "h" | "d"): number {
  return unit === "h" ? now + n * 3_600_000 : localMidnight(addDays(now, n));
}

/** A snoozed session whose wake moment has passed — a full attention event. */
export function isDue(until: number, now: number): boolean {
  return until <= now;
}

/** Compact "how long ago" for the wake banner: 3d / 16h / 5m (never 0m). */
export function snoozeSpan(snoozedAt: number, now: number): string {
  const span = now - snoozedAt;
  return span >= 86_400_000
    ? `${Math.round(span / 86_400_000)}d`
    : span >= 3_600_000
      ? `${Math.round(span / 3_600_000)}h`
      : `${Math.max(1, Math.round(span / 60_000))}m`;
}

/**
 * The line echoed above claude's UI in an auto-reopened wake window, so
 * walking into it later explains why the window exists.
 */
export function wakeBanner(snoozedAt: number, now: number): string {
  return `-- snooze wake: snoozed ${snoozeSpan(snoozedAt, now)} ago, due now - reopened automatically --`;
}

// ── section derivation ────────────────────────────────────────────────────

/** Which section a session renders in right now. null = History, off the sidebar. */
export function sectionOf(s: InboxSession, now: number): Section | null {
  if (s.archivedAt) {
    return now - s.archivedAt < 86_400_000 ? "done" : null; // >24h → History
  }
  if (s.disposition) {
    if (s.disposition.kind === "snoozed" && s.disposition.until <= now) {
      return "needs-you"; // woken — full attention event
    }
    return "parked";
  }
  if (s.running && s.running.finishAt > now) return "running";
  return "needs-you";
}

/** Effective "in this state since" for age display (accounts for derived flips). */
export function effectiveSince(s: InboxSession, now: number): number {
  if (s.running && s.running.finishAt <= now && !s.disposition && !s.archivedAt) {
    return s.running.finishAt; // finished while unattended — age from finish
  }
  if (s.disposition?.kind === "snoozed" && s.disposition.until <= now) {
    return s.disposition.until; // age from the wake moment
  }
  return s.since;
}

export function isWoken(s: InboxSession, now: number): boolean {
  return !s.archivedAt && s.disposition?.kind === "snoozed" && s.disposition.until <= now;
}

export interface InboxSections {
  needsYou: InboxSession[];
  running: InboxSession[];
  parked: InboxSession[];
  done: InboxSession[];
}

export function deriveSections(sessions: InboxSession[], now: number): InboxSections {
  const by = (sec: Section) => sessions.filter((s) => sectionOf(s, now) === sec);
  // running sorts longest-first on the same anchor its age displays
  // (script-waiters age from the handover, turns from the prompt)
  const runningSince = (s: InboxSession) => (s.script ? (s.scriptSince ?? s.since) : s.since);
  return {
    needsYou: by("needs-you").sort((a, b) => effectiveSince(a, now) - effectiveSince(b, now)), // oldest first
    running: by("running").sort((a, b) => runningSince(a) - runningSince(b)),
    // snoozed before blocked; snoozed by wake (soonest first), blocked by
    // time spent blocked (least first — since is when the block was set)
    parked: by("parked").sort((a, b) => {
      const ad = a.disposition!;
      const bd = b.disposition!;
      if (ad.kind !== bd.kind) return ad.kind === "snoozed" ? -1 : 1;
      if (ad.kind === "snoozed" && bd.kind === "snoozed") return ad.until - bd.until;
      return b.since - a.since;
    }),
    done: by("done").sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0)),
  };
}

// ── store composition ─────────────────────────────────────────────────────

import type { InboxStore } from "./inbox-store";

/**
 * Authored facts (disposition, archived, autoResumed) live in their own
 * tables; the activity snapshot must never shadow them.
 */
export function stripOverlay(s: InboxSession): InboxSession {
  const { disposition, archivedAt, autoResumed, ...rest } = s;
  return rest;
}

/** Compose render state: snapshot rows + authored overlay from the tables. */
export function composeSessions(store: InboxStore): InboxSession[] {
  const sessions: InboxSession[] = [];
  for (const r of store.loadSnapshot()) {
    try {
      sessions.push(JSON.parse(r.data) as InboxSession);
    } catch {}
  }
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const [id, d] of store.dispositions()) {
    const s = byId.get(id);
    if (!s) continue;
    s.disposition =
      d.kind === "snoozed"
        ? { kind: "snoozed", until: d.until! }
        : { kind: "blocked", note: d.note ?? "" };
    s.autoResumed = d.autoResumed;
  }
  for (const [id, at] of store.archivedAt()) {
    const s = byId.get(id);
    if (s) s.archivedAt = at;
  }
  return sessions;
}
