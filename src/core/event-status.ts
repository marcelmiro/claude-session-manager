/**
 * Event-sourced status derivation (Contract A).
 *
 * Pure function over the raw `HookEvent` history (append order, newest last).
 * Status comes from hook edges, NOT the scraped viewport — so the scroll-up
 * viewport that fools `detectStatus` (status.ts) is irrelevant here.
 *
 * Truth table (see `event-status.test.ts`):
 *   SessionStart                     → idle
 *   UserPromptSubmit                 → running
 *   PreToolUse (no PostToolUse yet)  → running
 *   PostToolUse (result in hand,     → running   (still working until Stop/idle —
 *     no Stop)                                     never map a bare PostToolUse to ready)
 *   Notification permission_prompt   → waiting
 *   Notification idle_prompt         → ready
 *   Stop                             → ready
 *
 * Inc4 widened the signature to accept `opts.transcript` for the missed-edge
 * backstop (ADR-4): when the edges say `running` but a dropped PostToolUse/Stop
 * could strand us, a `tool_result` already in the transcript for the dangling
 * PreToolUse demotes running→ready. The mtime-quiet half of the backstop lives in
 * the caller (`hook-events.ts`, which has fs access). Absent `opts.transcript`,
 * this derives from edges alone — so the Inc1 no-opts callers are unchanged.
 */

import type { SessionStatus } from "./status";
import type { TranscriptTurn } from "./transcript";

// Re-export so `event-status.test.ts` can import `HookEvent` from "./event-status".
export type { HookEvent } from "../types";
import type { HookEvent } from "../types";

export function deriveStatus(
  events: HookEvent[],
  opts?: { transcript?: TranscriptTurn[] },
): SessionStatus {
  const status = deriveFromEdges(events);
  if (status !== "running" || !opts?.transcript) return status;

  // Missed-edge backstop (pairing half): the edge history ends on an open
  // PreToolUse, but if the transcript already holds that tool's `tool_result`, the
  // tool completed and we lost the terminal edge → demote to ready.
  const danglingId = lastOpenToolUseId(events);
  if (danglingId && transcriptHasToolResult(opts.transcript, danglingId)) {
    return "ready";
  }
  return status;
}

/**
 * Derive status from hook edges alone. Walks newest → oldest and returns on the
 * first edge that determines status, so a trailing meta/unknown event never
 * strands the result.
 */
function deriveFromEdges(events: HookEvent[]): SessionStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    switch (event.hook_event_name) {
      case "Stop":
        return "ready";
      case "Notification":
        if (event.notification_type === "permission_prompt") return "waiting";
        if (event.notification_type === "idle_prompt") return "ready";
        continue; // unknown notification flavor — look further back
      case "PreToolUse":
        return "running";
      case "PostToolUse":
        // The tool finished, but the turn has not (no Stop) — Claude is still
        // working with the result. A bare PostToolUse is `running`, not `ready`.
        return "running";
      case "UserPromptSubmit":
        return "running";
      case "SubagentStop":
        // A subagent finished; the parent session is still active.
        return "running";
      case "SessionStart":
        return "idle";
      default:
        continue;
    }
  }
  return "idle";
}

/** The tool_use_id of the most recent PreToolUse with no matching PostToolUse. */
function lastOpenToolUseId(events: HookEvent[]): string | undefined {
  const closed = new Set<string>();
  for (const e of events) {
    if (e.hook_event_name === "PostToolUse" && e.tool_use_id) closed.add(e.tool_use_id);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.hook_event_name === "PreToolUse" && e.tool_use_id && !closed.has(e.tool_use_id)) {
      return e.tool_use_id;
    }
  }
  return undefined;
}

function transcriptHasToolResult(turns: TranscriptTurn[], toolUseId: string): boolean {
  return turns.some((t) =>
    t.content.some((b) => b.type === "tool_result" && b.tool_use_id === toolUseId),
  );
}
