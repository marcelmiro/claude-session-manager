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
import { pendingToolCall, readTranscriptSince } from "./hook-events";
import { loadPaneSessions } from "./state";
import { findClaudeProcesses } from "./process";
import {
  listPanes,
  sendTextAndEnter,
  answerQuestion,
  getMainSession,
  launchClaudeWindow,
  capturePane,
  sendKey,
  sendLiteral,
  sendBracketedPaste,
} from "./tmux";
import type { PendingQuestion, PendingToolCall } from "./jsonl-reader";
import type { TranscriptBlock, TranscriptTurn } from "../types";

export interface SessionTranscript {
  turns: TranscriptTurn[];
  cursor?: number; // byte offset to pass back as `?since=` for the next delta fetch
  full?: boolean; // true = `turns` is the whole conversation (client replaces, not appends)
  lastAssistant?: string;
  pendingTool?: PendingToolCall;
  openQuestion?: PendingQuestion;
  usage?: ContextUsage;
}

/** Context-window usage for the mobile status-bar readout (mirrors the Mac statusline). */
export interface ContextUsage {
  tokens: number; // input + cache_creation + cache_read of the last assistant turn
  size: number; // context-window size the tokens are measured against
  percent: number; // rounded tokens/size
}

/** The Claude pane's rendered statusline + permission-mode line, scraped from capture. */
export interface PaneStatusline {
  statusline?: string; // the user's custom statusline text (tokens • branch • model • …)
  mode?: string; // e.g. "⏵⏵ auto mode on", "⏸ plan mode on"
}

/**
 * Read the live statusline + mode straight from the pane — the only faithful source
 * for the user's CUSTOM statusline (its true context-window %, branch, model) and the
 * current permission mode (auto/plan), neither of which is in any file. The statusline
 * is anchored by its token `X/Y (Z%)` fragment; the mode by its ⏵⏵/⏸ marker.
 */
export async function readPaneStatusline(paneId: string): Promise<PaneStatusline> {
  const cap = await capturePane(paneId);
  const tail = cap.split("\n").map((l) => l.trimEnd()).slice(-12);
  const res: PaneStatusline = {};
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i]!.trim();
    if (!res.mode && /(⏵⏵|⏸|⏵).*(mode|accept edits|permissions)/i.test(l)) {
      res.mode = l.replace(/\s*\(shift\+tab[^)]*\)/i, "").replace(/\s*·.*$/, "").trim();
    }
    if (!res.statusline && /\d[\d.]*k?\s*\/\s*\d[\d.]*k?\s*\(\d+%\)/i.test(l)) {
      res.statusline = l;
    }
  }
  return res;
}

/** Outcome of a send; `reason` is set only on rejection (nothing was sent). */
export type SendResult = {
  ok: boolean;
  reason?: "no-pane" | "no-question" | "no-session" | "rewind-unavailable" | "rewind-mismatch" | "rewind-mode" | "bad-image";
  /** Fresh session id, set by createSession once the new pane's SessionStart hook lands. */
  sessionId?: string;
};

/**
 * Launch a new Claude session in `repoPath` as a new tmux window (TUI parity with the
 * `n` wizard's simple case — current branch, no worktree). Rejects when no main tmux
 * session is resolvable (e.g. the bridge is running outside tmux).
 *
 * Returns the new session's id by waiting for its SessionStart hook to write
 * `paneId → sessionId` into `pane-sessions.json` (claude boot ~1-4s). This is
 * deterministic — the caller opens exactly this session — and sidesteps the discovery
 * heuristics that, during the boot window, can mis-map the not-yet-registered pane to
 * a recently-modified existing session (the mtime fallback in enrichUnmatchedSessions).
 */
export async function createSession(repoPath: string, name: string): Promise<SendResult> {
  const target = await getMainSession();
  if (!target) return { ok: false, reason: "no-session" };
  const paneId = await launchClaudeWindow(target, repoPath, name);
  for (let i = 0; i < 24; i++) {
    await Bun.sleep(500); // up to ~12s for claude to boot and fire SessionStart
    const sessionId = (await loadPaneSessions())[paneId];
    if (sessionId) return { ok: true, sessionId };
  }
  return { ok: true }; // launched, but the id didn't register in time — list catches up via SSE
}

// --- Rewind: drive Claude's interactive /rewind picker via tmux --------------
// Claude exposes no rewind-by-message API; the picker is a two-stage Ink overlay.
// We drive it by KEYS but READ the screen at each step and abort (Esc) on any
// mismatch — never blind-pressing the destructive option. Calibrated live against
// claude 2.1.x: stage 1 lists user prompts oldest→newest with the cursor on
// "(current)"; `Up` walks toward older entries. Stage 2 is a numbered menu whose
// "Restore code …" options appear only when that checkpoint changed files.

const PICKER_DONE = "Enter to continue";
const PICKER_HEAD = "Restore the code and/or conversation";
const KEY_GAP = 250; // ms — the verified floor for Claude's TUI to register arrow keys

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The selected entry's text within the picker block (the line carrying `❯`). */
export function pickerCursorText(screen: string): string | null {
  const start = screen.indexOf(PICKER_HEAD);
  if (start === -1) return null;
  for (const line of screen.slice(start).split("\n")) {
    const m = line.match(/^\s*❯\s+(.+?)\s*$/);
    if (m && !line.includes(PICKER_DONE)) return norm(m[1]!);
  }
  return null;
}

/** True when the cursor text (possibly truncated with …) is a prefix of expected. */
export function cursorMatches(cursorText: string, expected: string): boolean {
  const c = cursorText.replace(/[…]+$/, "").replace(/\.\.\.$/, "").trim();
  if (c.length < 3) return false;
  return norm(expected).startsWith(c.slice(0, Math.min(c.length, 40)));
}

/** Parse the stage-2 numbered menu into {num,label} entries. */
export function parseModeMenu(screen: string): Array<{ num: number; label: string }> {
  const out: Array<{ num: number; label: string }> = [];
  for (const line of screen.split("\n")) {
    const m = line.match(/^\s*❯?\s*(\d+)\.\s+(.+?)\s*$/);
    if (m) out.push({ num: Number(m[1]), label: norm(m[2]!) });
  }
  return out;
}

/** Down-presses from the default (option 1) to the requested restore mode, or -1. */
export function modeDowns(menu: Array<{ num: number; label: string }>, mode: "conversation" | "both"): number {
  const want = mode === "both" ? "Restore code and conversation" : "Restore conversation";
  const exact = menu.find((o) => o.label === want);
  if (exact) return exact.num - 1;
  // "both" requested but no code changed → "Restore conversation" is the equivalent action
  if (mode === "both") {
    const conv = menu.find((o) => o.label === "Restore conversation");
    if (conv) return conv.num - 1;
  }
  return -1;
}

async function captureAfter(paneId: string, ms: number): Promise<string> {
  await Bun.sleep(ms);
  return capturePane(paneId);
}

/**
 * Rewind a session to the point BEFORE a specific user message. `upCount` is how many
 * `Up` presses from "(current)" reach that checkpoint (the caller computes it from the
 * message's position); `expectedText` is that message's text, used to VERIFY the cursor
 * landed correctly before committing. `mode`: "conversation" (safe) or "both" (also
 * restores files — destructive). Aborts cleanly on any mismatch.
 */
export async function rewindSession(
  sessionId: string,
  upCount: number,
  expectedText: string,
  mode: "conversation" | "both",
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  return rewindByPane(paneId, upCount, expectedText, mode);
}

/** The pane-level rewind driver (no session resolution) — the testable seam. */
export async function rewindByPane(
  paneId: string,
  upCount: number,
  expectedText: string,
  mode: "conversation" | "both",
): Promise<SendResult> {
  if (!Number.isInteger(upCount) || upCount < 1 || upCount > 500) {
    return { ok: false, reason: "rewind-unavailable" };
  }

  // Open the picker: clear any input, type /rewind, submit.
  await sendKey(paneId, "C-u");
  await Bun.sleep(120);
  await sendLiteral(paneId, "/rewind");
  await Bun.sleep(KEY_GAP);
  await sendKey(paneId, "Enter");

  let screen = "";
  for (let i = 0; i < 16; i++) {
    screen = await captureAfter(paneId, 200);
    if (screen.includes(PICKER_DONE) && screen.includes(PICKER_HEAD)) break;
  }
  if (!screen.includes(PICKER_DONE)) {
    await sendKey(paneId, "Escape");
    return { ok: false, reason: "rewind-unavailable" }; // not at prompt / picker didn't open
  }

  // Stage 1: walk up to the target checkpoint, then VERIFY before selecting.
  for (let n = 0; n < upCount; n++) {
    await sendKey(paneId, "Up");
    await Bun.sleep(KEY_GAP);
  }
  screen = await capturePane(paneId);
  const cursor = pickerCursorText(screen);
  if (!cursor || !cursorMatches(cursor, expectedText)) {
    await sendKey(paneId, "Escape");
    return { ok: false, reason: "rewind-mismatch" };
  }
  await sendKey(paneId, "Enter");

  // Stage 2: pick the restore mode by reading the numbered menu.
  screen = await captureAfter(paneId, 400);
  const downs = modeDowns(parseModeMenu(screen), mode);
  if (downs < 0) {
    await sendKey(paneId, "Escape");
    return { ok: false, reason: "rewind-mode" };
  }
  for (let n = 0; n < downs; n++) {
    await sendKey(paneId, "Down");
    await Bun.sleep(KEY_GAP);
  }
  await sendKey(paneId, "Enter");
  await Bun.sleep(400);
  return { ok: true };
}

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

// The tool_use chip shows ONE truncated line (command / file_path / pattern). Ship only
// that field, capped — not the full `input` (Write contents, Edit strings, long Bash
// commands), which is never rendered and is ~half the payload.
const TOOL_ARG_CAP = 200;
const TOOL_ARG_FIELDS = ["command", "file_path", "pattern"] as const;
function slimToolUse(b: Extract<TranscriptBlock, { type: "tool_use" }>): TranscriptBlock {
  const raw = (b.input ?? {}) as Record<string, unknown>;
  const input: Record<string, string> = {};
  for (const k of TOOL_ARG_FIELDS) {
    const v = raw[k];
    if (typeof v === "string") {
      input[k] = v.length > TOOL_ARG_CAP ? v.slice(0, TOOL_ARG_CAP) + "…" : v;
      break; // the chip reads the first present field; one is enough
    }
  }
  return { type: "tool_use", id: b.id, name: b.name, input };
}

/**
 * Keep only what the bridge UI renders — text bubbles and tool_use chips — and shrink
 * each to its displayed form. `thinking` is hidden and `tool_result` content is
 * frequently enormous (file reads, command output); both are dropped. tool_use inputs
 * are trimmed to the single capped field the chip shows. A turn left empty purely by
 * stripping is dropped; a genuinely empty turn is preserved (mirrors `parseTranscript`).
 */
export function slimTurns(turns: TranscriptTurn[]): TranscriptTurn[] {
  const out: TranscriptTurn[] = [];
  for (const t of turns) {
    const content: TranscriptBlock[] = [];
    for (const b of t.content) {
      if (b.type === "text" || b.type === "image") content.push(b);
      else if (b.type === "tool_use") content.push(slimToolUse(b));
    }
    if (content.length === 0 && t.content.length > 0) continue;
    out.push({ role: t.role, content });
  }
  return out;
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
export async function getTranscript(sessionId: string, since = 0): Promise<SessionTranscript> {
  const path = await resolveTranscriptPath(sessionId);
  // Append-only delta read: `since: 0` returns the whole (slimmed) conversation for a
  // first open; a prior cursor returns only the turns appended since, so each refresh
  // reads a few KB instead of re-parsing a multi-MB log. The slimmed blocks (no
  // thinking/tool_result, trimmed tool inputs) keep even the full read small.
  const slice = path
    ? await readTranscriptSince(path, since)
    : { turns: [], cursor: 0, fromStart: true };
  const result = buildSessionTranscript(slimTurns(slice.turns), pendingToolCall(sessionId));
  result.cursor = slice.cursor;
  result.full = slice.fromStart;
  if (path) {
    const usage = await readContextUsage(path);
    if (usage) result.usage = usage;
  }
  return result;
}

/**
 * Context-window usage, mirroring the user's Mac statusline: input +
 * cache_creation + cache_read from the LAST assistant message's `usage` (the full
 * context resent each turn), over the window size. The size isn't recorded in the
 * transcript — default to 200k, inferring the 1M beta when usage exceeds 200k.
 * Tail-reads the JSONL (last 64KB) so it stays cheap on multi-MB logs.
 */
export async function readContextUsage(transcriptPath: string): Promise<ContextUsage | null> {
  try {
    const file = Bun.file(transcriptPath);
    const bytes = file.size;
    if (!bytes) return null;
    const text = await file.slice(Math.max(0, bytes - 65536)).text();
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.includes('"usage"')) continue;
      let u: Record<string, unknown> | undefined;
      try {
        u = (JSON.parse(line) as { message?: { usage?: Record<string, unknown> } })?.message?.usage;
      } catch {
        continue; // partial line at the chunk's leading edge — skip it
      }
      if (u && typeof u.input_tokens === "number") {
        const tokens =
          (u.input_tokens as number) +
          ((u.cache_creation_input_tokens as number) || 0) +
          ((u.cache_read_input_tokens as number) || 0);
        const size = tokens > 200_000 ? 1_000_000 : 200_000;
        return { tokens, size, percent: Math.round((tokens * 100) / size) };
      }
    }
  } catch {
    // missing/unreadable transcript — no usage
  }
  return null;
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

/**
 * Pure command-line fallback for pane resolution (testable). Matches the live
 * `claude --resume <id>` process whose id equals `sessionId`, maps its TTY to a pane,
 * and returns that pane — UNLESS the hook map already assigns that pane to a DIFFERENT
 * session. That guard is the stale-id defense: after a /clear the process command line
 * still carries the launch id, so without it we'd mis-resolve the old id onto a live pane
 * that now hosts a new conversation. `--fork-session` is already excluded upstream by
 * `sessionIdFromCommand` (its `sessionId` is undefined), so a fork can't match here.
 */
export function paneFromCommandLine(
  sessionId: string,
  procs: Array<{ sessionId?: string; tty: string }>,
  panes: Array<{ paneId: string; tty: string }>,
  paneMap: Record<string, string>,
): string | null {
  const norm = (tty: string) => tty.replace(/^\/dev\//, ""); // ps: "ttys013"; tmux: "/dev/ttys013"
  const proc = procs.find((p) => p.sessionId === sessionId);
  if (!proc) return null;
  const pane = panes.find((p) => norm(p.tty) === norm(proc.tty));
  if (!pane) return null;
  if (paneMap[pane.paneId] && paneMap[pane.paneId] !== sessionId) return null; // stale-id guard
  return pane.paneId;
}

/**
 * Resolve a session's live tmux pane. Primary source is the SessionStart-hook map
 * (`pane-sessions.json`), reverse-looked-up against live panes. Fallback is the live
 * `claude --resume <id>` process command line — the SAME authoritative path
 * `discoverSessions` uses — for sessions the hook never recorded (e.g. resumed before
 * `csm setup`, or whose hook event was consumed without persisting). Without the
 * fallback, such a session shows in the list (discovery resolves it) but the bridge's
 * statusline scrape / mark-read / send can't find its pane. Hook map wins, and the
 * fallback is guarded against stale launch ids (see `paneFromCommandLine`).
 */
export async function resolveSessionPane(sessionId: string): Promise<string | null> {
  const [paneMap, panes] = await Promise.all([loadPaneSessions(), listPanes()]);
  const livePaneIds = new Set(panes.map((p) => p.paneId));
  const fromHook = pickPane(sessionId, paneMap, livePaneIds);
  if (fromHook) return fromHook;

  return paneFromCommandLine(sessionId, await findClaudeProcesses(), panes, paneMap);
}

/** True when an AskUserQuestion is open (vs. a permission prompt or no pending tool). */
export function hasOpenQuestion(pending: PendingToolCall | null): boolean {
  return pending?.name === "AskUserQuestion" && !!pending.question;
}

/** One keystroke action in a composed message — image paste, caption text, or submit. */
export type MessageStep =
  | { kind: "paste"; text: string } // bracketed-paste an image path → becomes [Image #N]
  | { kind: "literal"; text: string } // type caption text literally
  | { kind: "enter" }; // submit

/**
 * Pure builder for the keystroke sequence of a message (extracted for testability,
 * mirroring `questionAnswerKeys`). Images are pasted FIRST — each becomes its own
 * `[Image #N]` in the prompt — then the caption (with a leading space to separate it from
 * the trailing marker), then a single terminal Enter to submit. Empty caption / no images
 * are both fine: text-only → `[literal, enter]`; image-only → `[paste…, enter]`.
 */
export function composeMessageSteps(text: string, imagePaths: string[] = []): MessageStep[] {
  const steps: MessageStep[] = imagePaths.map((p) => ({ kind: "paste", text: p }));
  const caption = text.trim() ? (imagePaths.length > 0 ? ` ${text}` : text) : "";
  if (caption) steps.push({ kind: "literal", text: caption });
  steps.push({ kind: "enter" });
  return steps;
}

/**
 * Send a message (optional images + optional text) to a session's pane — TUI parity: the
 * TUI sends keys unconditionally, so the bridge does too (Claude Code queues input while
 * running, accepts it at the prompt). The ONLY gate is a live pane. Blocked-on-question/
 * permission states are steered to the structured answer/approval UI client-side.
 *
 * Text-only keeps the proven single `sendTextAndEnter` helper (and its paste-coalescing
 * fix). With images, each path is bracketed-pasted (→ `[Image #N]`) and steps are spaced
 * by `KEY_GAP` so each paste registers and the terminal Enter submits rather than being
 * absorbed as a paste newline (validated live).
 */
export async function sendMessage(
  sessionId: string,
  text: string,
  imagePaths: string[] = [],
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  if (imagePaths.length === 0) {
    await sendTextAndEnter(paneId, text);
    return { ok: true };
  }
  for (const step of composeMessageSteps(text, imagePaths)) {
    if (step.kind === "paste") {
      await sendBracketedPaste(paneId, step.text);
      await Bun.sleep(KEY_GAP);
    } else if (step.kind === "literal") {
      await sendLiteral(paneId, step.text);
      await Bun.sleep(KEY_GAP);
    } else {
      // Submit with verify-retry: the Enter after an image paste is dropped if the TUI is
      // still ingesting the pasted image (the file is base64-embedded at paste time) —
      // reliably so on the session's first message right after boot. Settle, press Enter,
      // and confirm the input cleared; resend if the caption/[Image] is still pending.
      await Bun.sleep(KEY_GAP);
      for (let i = 0; i < 4; i++) {
        await sendKey(paneId, "Enter");
        await Bun.sleep(450);
        if (!inputPending(await capturePane(paneId))) break;
      }
    }
  }
  return { ok: true };
}

/**
 * Whether the pane's prompt still holds unsubmitted input — used to confirm an image
 * message actually submitted. The live input is the LAST `❯` line in the capture; any
 * non-whitespace after the glyph means the Enter hasn't landed yet. (Submitted messages
 * also echo as `❯ …` lines higher up, hence "last".)
 */
export function inputPending(capture: string): boolean {
  const lines = capture.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^❯\s?(.*)$/);
    if (m) return m[1]!.trim().length > 0;
  }
  return false;
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
