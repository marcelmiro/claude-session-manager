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
 */
export async function resolveTranscriptPath(
  sessionId: string,
  projectsDir?: string,
): Promise<string | null> {
  const dir = projectsDir ?? `${homedir()}/.claude/projects`;
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
      if (record.type !== "user" && record.type !== "assistant") continue;
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

