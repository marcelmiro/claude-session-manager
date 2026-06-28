/**
 * Session handoff surface (Impl 2.5) — the `core/` functions the Impl #3 bridge
 * consumes so it stays a thin transport/presentation layer with no new
 * Claude-wrapping logic. All additive, read-only over existing on-disk artifacts
 * (`pane-sessions.json`, `events/<id>.jsonl`, transcript JSONL); the senders reuse
 * the existing `send-keys` path. Headless: no blessed/ui imports (boundary.test.ts).
 *
 * `SessionTranscript`/`SendResult` are co-located here (not in `types.ts`) because
 * they reference `PendingToolCall`/`PendingQuestion`, which live in `jsonl-reader.ts`
 * — hoisting them into `types.ts` would create a `types.ts → core/` import that does
 * not exist today.
 */

import { Glob } from "bun";
import { homedir } from "os";
import { lastAssistantMessage } from "./transcript";
import { pendingToolCall, readTranscriptTurns } from "./hook-events";
import { nativeStatus } from "./session-state";
import { eventSourcedStatus } from "./hook-events";
import { loadPaneSessions } from "./state";
import { listPanes, sendTextAndEnter, answerQuestion } from "./tmux";
import type { PendingQuestion, PendingToolCall } from "./jsonl-reader";
import type { TranscriptTurn } from "../types";
import type { SessionStatus } from "./status";

export interface SessionTranscript {
  turns: TranscriptTurn[];
  lastAssistant?: string;
  pendingTool?: PendingToolCall;
  openQuestion?: PendingQuestion;
}

/** Outcome of a send; `reason` is set only on rejection (nothing was sent). */
export type SendResult = { ok: boolean; reason?: "no-pane" | "not-at-prompt" | "no-question" };

/**
 * Absolute path to a live session's transcript, or null if none is found. Globs
 * `<proj>/<id>.jsonl` under `~/.claude/projects` via `homedir()` (matches
 * `sessions.ts`'s projects-dir resolution). `~` does NOT expand, and `Bun.Glob`
 * yields cwd-relative matches, so we rejoin the match with the dir.
 */
export async function resolveTranscriptPath(sessionId: string): Promise<string | null> {
  const dir = `${homedir()}/.claude/projects`;
  try {
    for await (const match of new Glob(`*/${sessionId}.jsonl`).scan({ cwd: dir })) {
      return `${dir}/${match}`;
    }
  } catch {
    // missing projects dir or scan failure — no transcript
  }
  return null;
}

/**
 * Pure assembly of the transcript view from its already-read inputs (extracted as
 * the testable seam — the I/O path resolution uses `homedir()`, which tests can't
 * redirect). `openQuestion` is the pending tool's question when it is an
 * `AskUserQuestion`; otherwise only `pendingTool` is set.
 */
export function buildSessionTranscript(
  turns: TranscriptTurn[],
  pendingTool: PendingToolCall | null,
): SessionTranscript {
  const result: SessionTranscript = { turns };
  const lastAssistant = lastAssistantMessage(turns);
  if (lastAssistant !== undefined) result.lastAssistant = lastAssistant;
  if (pendingTool) result.pendingTool = pendingTool;
  if (pendingTool?.question) result.openQuestion = pendingTool.question;
  return result;
}

/**
 * Aggregate a live session's transcript view: ordered turns + last assistant text +
 * the pending tool/question (sourced from the hook log, A3 — pending interactions
 * are not in the transcript before they resolve).
 */
export async function getTranscript(sessionId: string): Promise<SessionTranscript> {
  const path = await resolveTranscriptPath(sessionId);
  const turns = path ? await readTranscriptTurns(path) : [];
  return buildSessionTranscript(turns, pendingToolCall(sessionId));
}

/**
 * Among live panes mapping to `sessionId`, return the LAST matching entry in
 * `paneMap` iteration order (last-written wins — handles resume-into-a-new-pane
 * before the stale entry is evicted); null if none. A plain object walk on purpose:
 * tmux paneIds are `%`-prefixed, so `JSON.parse` preserves insertion order.
 */
export function pickPane(
  sessionId: string,
  paneMap: Record<string, string>,
  livePaneIds: Set<string>,
): string | null {
  let pick: string | null = null;
  for (const [paneId, sid] of Object.entries(paneMap)) {
    if (sid === sessionId && livePaneIds.has(paneId)) pick = paneId;
  }
  return pick;
}

/** Effectful `pickPane`: reverse-lookup `pane-sessions.json` against live panes. */
export async function resolveSessionPane(sessionId: string): Promise<string | null> {
  const paneMap = await loadPaneSessions();
  const livePaneIds = new Set((await listPanes()).map((p) => p.paneId));
  return pickPane(sessionId, paneMap, livePaneIds);
}

/**
 * Live status for the send-gate, mirroring discovery precedence (native › event) so
 * the gate uses the SAME status the bridge displays. Null when neither source exists.
 */
export async function resolveSessionStatus(sessionId: string): Promise<SessionStatus | null> {
  return (await nativeStatus(sessionId)) ?? (await eventSourcedStatus(sessionId));
}

/**
 * Free text is valid input only at the prompt. Gate is `ready` ONLY: in CSM's model
 * `ready` is the waiting-for-input prompt, while `waiting` = blocked on a
 * permission/question, where free text is the wrong input.
 */
export function canSendFreeText(status: SessionStatus | null): boolean {
  return status === "ready";
}

/** True when an AskUserQuestion is open (vs. a permission prompt or no pending tool). */
export function hasOpenQuestion(pending: PendingToolCall | null): boolean {
  return pending?.name === "AskUserQuestion" && !!pending.question;
}

/**
 * Send free text + Enter to a session's pane, status-gated on `ready`. Rejects with
 * a reason (and sends nothing) when the pane is gone or the session is not at prompt.
 */
export async function sendMessage(sessionId: string, text: string): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  if (!canSendFreeText(await resolveSessionStatus(sessionId))) {
    return { ok: false, reason: "not-at-prompt" };
  }
  await sendTextAndEnter(paneId, text);
  return { ok: true };
}

/**
 * Answer an open AskUserQuestion by option index (0-based). Gates on an open question
 * being present — NOT bare `waiting`, which also covers permission prompts (those
 * route to `decideApproval`, never here). Rejects with a reason and sends nothing
 * when the pane is gone or no question is open.
 */
export async function answerSessionQuestion(
  sessionId: string,
  selection: number | number[],
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  if (!hasOpenQuestion(pendingToolCall(sessionId))) return { ok: false, reason: "no-question" };
  await answerQuestion(paneId, selection);
  return { ok: true };
}
