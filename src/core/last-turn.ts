/**
 * Last *conversational* activity for a session — the timestamp both the TUI and the
 * phone show as a session's age.
 *
 * Why not the JSONL's file mtime (what `Session.modified` is): Claude Code appends
 * timestamp-less bookkeeping records — `mode`, `permission-mode`, `ai-title`,
 * `last-prompt`, `file-history-snapshot` — long after the conversation stops, and a
 * bulk resume re-stamps every live transcript at once. Both bump mtime with zero
 * activity, so a session idle for weeks can read as minutes old.
 *
 * Conversational records (`type` of `user`/`assistant`, per `transcript.ts`) carry a
 * real `timestamp`; that is what we read. A tail read suffices — the newest record is
 * at the end of the file — and results are memoized on the file's mtime, so an
 * unchanged transcript costs one `stat` per discovery cycle.
 */

import { Glob } from "bun";
import { homedir } from "os";
import { isQueuedPromptAttachment } from "./transcript";

/** Bytes of the file tail scanned for the newest conversational record. */
const TAIL_SIZE = 64 * 1024;

/** path → {mtimeMs at read time, resolved timestamp}. Invalidated when mtime moves. */
const cache = new Map<string, { mtimeMs: number; at: number | null }>();

/**
 * Absolute path to a session's transcript, or null if none is found. Globs
 * `<proj>/<id>.jsonl` under `~/.claude/projects` (matches `sessions.ts`'s projects-dir
 * resolution). `~` does NOT expand, and `Bun.Glob` yields cwd-relative matches, so we
 * rejoin the match with the dir.
 *
 * A session's cwd can move between project dirs (e.g. worktree → base repo), leaving
 * the SAME id as a JSONL in several dirs. Pick the most-recently-written so every
 * reader (transcript, mark-read, restore, age) follows the live conversation rather
 * than a frozen copy — an age read from a stale copy and messages read from the live
 * one would disagree by hours.
 *
 * Memoized briefly (default projects dir only — callers passing an explicit dir get a
 * fresh scan; positive hits only, so a brand-new session's JSONL is found the moment it
 * exists): one discovery cycle resolves every session, and each glob walks every project
 * dir. The TTL also bounds how long a newest-copy flip (cwd moved worktree↔base) can go
 * unnoticed.
 */
const RESOLVE_TTL = 3000;
const resolveCache = new Map<string, { ts: number; path: string }>();

export async function resolveTranscriptPath(
  sessionId: string,
  projectsDir?: string,
): Promise<string | null> {
  const dir = projectsDir ?? `${homedir()}/.claude/projects`;
  if (!projectsDir) {
    const hit = resolveCache.get(sessionId);
    if (hit && Date.now() - hit.ts < RESOLVE_TTL) return hit.path;
  }
  try {
    let best: string | null = null;
    let bestMtime = -Infinity;
    for await (const match of new Glob(`*/${sessionId}.jsonl`).scan({ cwd: dir })) {
      const path = `${dir}/${match}`;
      const mtime = Bun.file(path).lastModified;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = path;
      }
    }
    if (best && !projectsDir) resolveCache.set(sessionId, { ts: Date.now(), path: best });
    return best;
  } catch {
    // missing projects dir or scan failure — no transcript
  }
  return null;
}

/**
 * Epoch ms of the newest conversational record in a transcript, or null when the file
 * is unreadable or holds no timestamped turn (callers fall back to the file mtime).
 */
/**
 * The record types that carry conversation. This is what "last turn" means here and what
 * the search corpus is built from (`core/search.ts`) — one definition, so a session's
 * age and its searchable content can never disagree about which records count.
 */
export function isConversationalRecord(rec: { type?: string }): boolean {
  return rec.type === "user" || rec.type === "assistant";
}

export async function readLastTurnAt(transcriptPath: string): Promise<number | null> {
  try {
    const file = Bun.file(transcriptPath);
    const stat = await file.stat();
    if (!stat) return null;

    const hit = cache.get(transcriptPath);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.at;

    const chunk = await file.slice(Math.max(0, stat.size - TAIL_SIZE), stat.size).text();
    const lines = chunk.split("\n");
    let at: number | null = null;
    // Scan back-to-front: the newest record is last, so the first hit wins. The leading
    // line may be a partial record (the tail can start mid-line) — per-line try/parse
    // drops it, same as the rest of the JSONL readers.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let record: { type?: string; timestamp?: string };
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isConversationalRecord(record)) continue;
      const ts = record.timestamp ? new Date(record.timestamp).getTime() : NaN;
      if (!Number.isFinite(ts)) continue;
      at = ts;
      break;
    }
    cache.set(transcriptPath, { mtimeMs: stat.mtimeMs, at });
    return at;
  } catch {
    return null; // unreadable transcript — caller falls back to mtime
  }
}

// Non-prompt user records: harness plumbing that Claude logs with role user. Mirrors the
// phone's isPromptTurn (rewind checkpoints) — tool_results are excluded structurally below.
const NON_PROMPT_PREFIXES = [
  "<task-notification>",
  "<command-",
  "<local-command",
  "<system-reminder>",
  "Caveat:",
  "[Request interrupted",
];

/**
 * Whether a parsed JSONL record is a REAL typed prompt — a `user` record whose content
 * is text/image from the human, not a tool_result, task-notification, slash-command
 * echo, or interrupt marker. A `queued_command` prompt attachment counts too: a message
 * consumed from the input queue mid-turn never becomes a `user` record, but the human
 * did just prompt. Exported for tests; the timestamp is read by the caller.
 */
export function isPromptRecord(rec: {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  message?: { content?: unknown };
  attachment?: { type?: string; commandMode?: string; prompt?: unknown };
}): boolean {
  if (rec.isMeta === true || rec.isSidechain === true) return false;
  if (rec.type === "attachment") {
    // Same gate the transcript parser uses (commandMode, not origin.kind), so the
    // thread's queued turns and this prompt boundary stay in lockstep.
    if (!isQueuedPromptAttachment(rec)) return false;
    const t = typeof rec.attachment?.prompt === "string" ? rec.attachment.prompt.trimStart() : "";
    return t.length > 0 && !NON_PROMPT_PREFIXES.some((p) => t.startsWith(p));
  }
  if (rec.type !== "user") return false;
  const content = rec.message?.content;
  if (typeof content === "string") {
    const t = content.trimStart();
    return t.length > 0 && !NON_PROMPT_PREFIXES.some((p) => t.startsWith(p));
  }
  if (!Array.isArray(content)) return false;
  const blocks = content as Array<{ type?: string; text?: unknown }>;
  if (blocks.some((b) => b.type === "tool_result")) return false;
  return blocks.some(
    (b) =>
      b.type === "image" ||
      (b.type === "text" &&
        typeof b.text === "string" &&
        b.text.trim().length > 0 &&
        !NON_PROMPT_PREFIXES.some((p) => (b.text as string).trimStart().startsWith(p))),
  );
}

/** path → {mtimeMs, resolved prompt timestamp}. Same shape as the last-turn cache. */
const promptCache = new Map<string, { mtimeMs: number; at: number | null }>();

/**
 * Epoch ms of the newest REAL user prompt in a transcript (see `isPromptRecord`), or
 * null when none is found. The last prompt can sit far behind a long agentic turn's
 * tail, so this scans backward in doubling windows (64KB → whole file) instead of a
 * fixed tail — the scan stops at the first prompt, which is near the end in practice.
 */
export async function readLastPromptAt(transcriptPath: string): Promise<number | null> {
  try {
    const file = Bun.file(transcriptPath);
    const stat = await file.stat();
    if (!stat) return null;
    const hit = promptCache.get(transcriptPath);
    if (hit && hit.mtimeMs === stat.mtimeMs) return hit.at;

    let at: number | null = null;
    let scannedTo = stat.size; // lines at/after this offset were covered by a previous window
    for (let window = TAIL_SIZE; ; window *= 2) {
      const start = Math.max(0, stat.size - window);
      const chunk = await file.slice(start, scannedTo).text();
      const lines = chunk.split("\n");
      const first = start > 0 ? 1 : 0; // leading line may be a partial record
      for (let i = lines.length - 1; i >= first; i--) {
        const line = lines[i]!.trim();
        // Queued-prompt attachments don't carry `"type":"user"` — match their own marker.
        if (!line || (!line.includes('"type":"user"') && !line.includes('"queued_command"'))) continue;
        let rec: Parameters<typeof isPromptRecord>[0] & { timestamp?: string };
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isPromptRecord(rec)) continue;
        const ts = rec.timestamp ? new Date(rec.timestamp).getTime() : NaN;
        if (!Number.isFinite(ts)) continue;
        at = ts;
        break;
      }
      if (at !== null || start === 0) break;
      // Re-scan window overlap is bounded: the next pass reads [newStart, start+partial).
      scannedTo = start + (lines[0]?.length ?? 0) + 1;
    }
    promptCache.set(transcriptPath, { mtimeMs: stat.mtimeMs, at });
    return at;
  } catch {
    return null; // unreadable transcript
  }
}

/**
 * The session's CURRENT working directory as Claude sees it — the `cwd` on the last
 * transcript entry that carries one. This tracks `/cd` (which moves Claude's cwd forward
 * but leaves the launching shell — and thus the tmux pane's cwd — where it started), so
 * repo-scoped readers follow the directory the user actually switched to. Tail-reads the
 * JSONL (last 64KB) so it stays cheap on multi-MB logs. Null if no `cwd` line is found.
 */
export async function latestTranscriptCwd(transcriptPath: string): Promise<string | null> {
  try {
    const file = Bun.file(transcriptPath);
    const bytes = file.size;
    if (!bytes) return null;
    const text = await file.slice(Math.max(0, bytes - 65536)).text();
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd) return cwd;
      } catch {
        continue; // partial line at the chunk's leading edge — skip it
      }
    }
  } catch {
    // missing/unreadable transcript — no cwd
  }
  return null;
}

