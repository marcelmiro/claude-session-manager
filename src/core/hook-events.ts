/**
 * Per-session hook event log reader (Inc3).
 *
 * The WRITER is the installed hook script (`event.sh` / `pretooluse.sh`), which
 * appends the raw hook payload — one JSON object per line — to
 * `events/<session_id>.jsonl`. This module only reads.
 *
 * Read WITHOUT truncation (append order, newest last) — `deriveStatus` needs the
 * recent edge history, which is incompatible with the consume-and-truncate
 * contract of the separate `hook-events` pane-map (`state.ts`, untouched). Corrupt
 * or half-written lines are skipped (per-line try/parse) for forward/partial-write
 * safety. Sync to match the contract signature and avoid an await on the ~3s
 * discovery hot path (the log is bounded to ~200 lines).
 */

import { readFileSync, statSync } from "node:fs";
import { PATHS } from "./config";
import { deriveStatus, toolInFlight } from "./event-status";
import { recordQuietDemote } from "./debug";
import { parseTranscript } from "./transcript";
import type { PendingToolCall } from "./jsonl-reader";
import type { HookEvent, TranscriptTurn } from "../types";
import type { SessionStatus } from "./status";

export const EVENTS_DIR = `${PATHS.dir}/events`;

/** A silent transcript for longer than this demotes a stranded "running" → ready. */
const QUIET_MS = 150_000; // ~2.5 min (ADR-4 "~2–3 min"); no CPU sampling

/**
 * Grace period before the missed-edge backstop trusts a transcript `tool_result`.
 * Between back-to-back tools the transcript holds a tool's `tool_result` a few ms
 * before its `PostToolUse` edge is logged — a fresher transcript than this means a
 * tool is in-flight (PostToolUse imminent), NOT a dropped terminal edge. Demoting
 * then would flip an actively-working session `ready`↔`running` between tools and
 * fire spurious `turnComplete` pings. An actively-working session rewrites its
 * transcript every few seconds, so its mtime never ages past this.
 */
const SETTLE_MS = 12_000;

/** Absolute path to a session's event log. */
export function eventLogPath(sessionId: string): string {
  return `${EVENTS_DIR}/${sessionId}.jsonl`;
}

/** Whether an event log exists for this session (drives the opt-in fallback). */
export function hasEventLog(sessionId: string): boolean {
  try {
    readFileSync(eventLogPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/** Read a session's hook events in append order (newest last); [] if no log. */
export function readEvents(sessionId: string): HookEvent[] {
  let raw: string;
  try {
    raw = readFileSync(eventLogPath(sessionId), "utf8");
  } catch {
    return []; // no log yet (ENOENT) — opt-in fallback handles this
  }

  const events: HookEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as HookEvent);
    } catch {
      continue; // corrupt/half-written line — skip
    }
  }
  return events;
}

/**
 * Missed-edge backstop decision (pure; the caller supplies the transcript and how
 * long since it was last written). Only meaningful when the edge status is already
 * `running`. Two demotions, both time-gated so an actively-working session (fresh
 * transcript) is never demoted between tools:
 *   - tool_result for the dangling PreToolUse + transcript settled (`SETTLE_MS`)
 *     → its terminal edge was genuinely dropped → `ready`.
 *   - no such evidence but the transcript has been silent for `QUIET_MS`
 *     → a dropped Stop edge stranded `running` → `ready` (ADR-4).
 *
 * The `QUIET_MS` demotion is suppressed while a tool is genuinely in-flight
 * (`toolInFlight`): a long Bash (build/test/dev-server) holds an open PreToolUse
 * and writes nothing to the transcript for minutes, so the silence is the *tool
 * working*, not a dropped edge. Demoting it flipped a working session to `ready`
 * mid-run. The dropped-PostToolUse case is still covered by the pairing demotion
 * above (the result lands in the transcript), so suppressing here only trades a
 * rare, self-healing false-`running` for the common false-`ready`.
 */
export function backstopStatus(
  events: HookEvent[],
  transcript: TranscriptTurn[],
  mtimeAgeMs: number,
): SessionStatus {
  if (mtimeAgeMs > SETTLE_MS) {
    const settled = deriveStatus(events, { transcript });
    if (settled !== "running") return settled;
  }
  if (mtimeAgeMs > QUIET_MS && !toolInFlight(events)) return "ready";
  return "running";
}

/**
 * Event-sourced status for a session, or `null` if it has no event log (the
 * caller then falls back to the `status.ts` scraper — ADR-2 opt-in by presence).
 *
 * The missed-edge backstop (ADR-4) runs ONLY when the edge-derived status is
 * `running`. The transcript is read only once it has settled past `SETTLE_MS`
 * (fresh transcript = tool in-flight ⇒ trust the edge, no read), so the common
 * actively-working path stays a single event-log read.
 */
export async function eventSourcedStatus(sessionId: string): Promise<SessionStatus | null> {
  const events = readEvents(sessionId);
  if (events.length === 0) return null;

  const edgeStatus = deriveStatus(events);
  if (edgeStatus !== "running") return edgeStatus;

  const transcriptPath = events[events.length - 1].transcript_path;
  let mtimeAgeMs: number;
  try {
    mtimeAgeMs = Date.now() - statSync(transcriptPath).mtimeMs;
  } catch {
    return "running"; // can't verify → trust the edge, never spuriously demote
  }

  // Skip the transcript read entirely while a tool is in-flight (the hot path).
  const transcript = mtimeAgeMs > SETTLE_MS ? await readTranscriptTurns(transcriptPath) : [];
  const status = backstopStatus(events, transcript, mtimeAgeMs);

  // ADR-4 on probation: record ONLY the QUIET_MS timeout demotion (not the
  // evidence-based pairing one — that's `deriveStatus(... transcript) === ready`).
  // If this never fires on a genuinely-working session in dogfooding, QUIET_MS can
  // be deleted; if it does, we've found a real dropped-Stop pattern to fix in the
  // hook. Cold path only; durable log so a rare event survives a multi-day probation.
  if (
    status === "ready" &&
    mtimeAgeMs > QUIET_MS &&
    !toolInFlight(events) &&
    deriveStatus(events, { transcript }) !== "ready"
  ) {
    await recordQuietDemote(
      `${sessionId.slice(0, 8)} age=${Math.round(mtimeAgeMs / 1000)}s ` +
        `nev=${events.length} lastEdge=${events[events.length - 1]?.hook_event_name}`,
    );
  }
  return status;
}

/**
 * The tool/question awaiting approval, sourced from the last open PreToolUse
 * event (A3: pending interactions are NOT in the transcript before they resolve).
 * Returns null when no PreToolUse is open. Shape mirrors `jsonl-reader`'s
 * `PendingToolCall` so the preview/Space-menu renderers consume it unchanged.
 */
export function pendingToolCall(sessionId: string): PendingToolCall | null {
  const events = readEvents(sessionId);
  const closed = new Set<string>();
  for (const e of events) {
    if (e.hook_event_name === "PostToolUse" && e.tool_use_id) closed.add(e.tool_use_id);
  }
  let pre: HookEvent | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.hook_event_name === "PreToolUse" && e.tool_use_id && !closed.has(e.tool_use_id)) {
      pre = e;
      break;
    }
  }
  if (!pre?.tool_name) return null;

  const input = (pre.tool_input ?? {}) as Record<string, any>;
  const toolUseId = pre.tool_use_id ?? "";
  const call: PendingToolCall = { name: pre.tool_name, toolUseId };
  if (typeof input.file_path === "string") call.filePath = input.file_path;
  if (typeof input.command === "string") call.command = input.command;
  if (typeof input.description === "string") call.description = input.description;
  if (typeof input.pattern === "string") call.pattern = input.pattern;
  if (pre.tool_name === "Edit") {
    if (typeof input.old_string === "string") call.oldString = input.old_string;
    if (typeof input.new_string === "string") call.newString = input.new_string;
  } else if (pre.tool_name === "Write") {
    if (typeof input.content === "string") call.content = input.content.slice(0, 500);
  } else if (pre.tool_name === "AskUserQuestion" && input.questions?.[0]) {
    const q = input.questions[0];
    call.question = {
      question: q.question || "",
      header: q.header || "",
      options: (q.options || []).map((o: any) => ({ label: o.label || "", description: o.description })),
      multiSelect: q.multiSelect || false,
      toolUseId,
    };
  }
  return call;
}

/** Tail-read + parse a transcript (tolerant of the truncated first line). */
export async function readTranscriptTurns(path: string): Promise<TranscriptTurn[]> {
  try {
    const file = Bun.file(path);
    const stat = await file.stat();
    if (!stat) return [];
    const TAIL = 64 * 1024;
    const offset = Math.max(0, stat.size - TAIL);
    const chunk = await file.slice(offset, stat.size).text();
    return parseTranscript(chunk);
  } catch {
    return [];
  }
}
