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
import { lastAssistantMessage, parseActiveBranch, parseTranscript } from "./transcript";
import { pendingToolCall } from "./hook-events";
import { loadPaneSessions, savePaneSessions } from "./state";
import { findClaudeProcesses } from "./process";
import {
  listPanes,
  sendTextAndEnter,
  answerQuestion,
  getMainSession,
  launchClaudeWindow,
  launchResumeWindow,
  capturePane,
  sendKey,
  sendLiteral,
  sendBracketedPaste,
  killPane,
} from "./tmux";
import { isPermissionPrompt } from "./status";
import { decideQuestion, buildAnswersMap } from "./approval";
import type { PendingQuestion, PendingToolCall } from "./jsonl-reader";
import type { TranscriptBlock, TranscriptTurn } from "../types";

export interface SessionTranscript {
  turns: TranscriptTurn[];
  lastAssistant?: string;
  pendingTool?: PendingToolCall;
  /** First question of an open AskUserQuestion (single-question display path). */
  openQuestion?: PendingQuestion;
  /** Every question of an open AskUserQuestion (drives the multi-question answer UI). */
  openQuestions?: PendingQuestion[];
  usage?: ContextUsage;
  /** Subagents this session fanned out to (sourced from the `subagents/` dir); omitted when none. */
  subagents?: SubagentSummary[];
  /**
   * Opaque disk revision of the transcript file (`size:mtimeMs`) — bumps on ANY JSONL write
   * (append OR rewind's new branch). The phone snapshots it at rewind time and clears its
   * optimistic (truncated + prefilled) view once `rev` changes, i.e. once the resend lands.
   */
  rev?: string;
}

/**
 * One `Agent`/`Task` subagent the phone can drill into. Sourced from the session's
 * `subagents/agent-<agentId>.meta.json` + the agent's own jsonl. `spawnDepth` is present
 * on only ~43% of agents (a cheap indent when we have it) — hence optional.
 */
export interface SubagentSummary {
  agentId: string;
  agentType: string;
  description: string;
  status: "done" | "running";
  spawnDepth?: number;
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
  model?: string; // current model as an arg key (opus/sonnet/…), parsed from the statusline
  effort?: string; // current reasoning effort (low/…/ultracode), when the statusline renders it
}

// The model/effort arg forms Claude accepts (`/model <x>`, `/effort <x>`) — the switcher's
// allowlists. Note `opus[1m]`, NOT `opus`: the bare `opus` arg resolves to the non-1M base
// model (`claude-opus-4-8`), whereas the picker's "Opus" and "Default" both select the 1M
// variant (`claude-opus-4-8[1m]`). `opus[1m]` is the arg that reaches 1M.
export const MODEL_ARGS = ["default", "opus[1m]", "fable", "sonnet", "haiku"] as const;
export const EFFORT_ARGS = ["low", "medium", "high", "xhigh", "max", "ultracode"] as const;
export const isModelArg = (v: string): boolean => (MODEL_ARGS as readonly string[]).includes(v);
export const isEffortArg = (v: string): boolean => (EFFORT_ARGS as readonly string[]).includes(v);

// Non-Opus families map display → arg key directly. Opus is special (1M vs base variant) and
// is handled inline in parseStatusline.
const MODEL_FAMILIES: Array<[RegExp, string]> = [
  [/sonnet/i, "sonnet"],
  [/haiku/i, "haiku"],
  [/fable/i, "fable"],
];

/**
 * Parse the current model (as an arg key) and effort level out of the rendered statusline
 * (`tokens • branch • model • <effort>`), by TOKEN-SCAN not fixed index — the effort segment
 * is absent for models without reasoning effort, and its position shifts. Returns only the
 * fields it can identify; a garbled/foreign statusline yields `{}` (never throws).
 *
 * Opus renders in two variants: "Opus 4.8 (1M context)" → `opus[1m]` (the menu's Opus option,
 * also how "Default" renders), and plain "Opus 4.8" → `opus` (the non-1M base, not in the menu
 * so it simply marks nothing).
 */
export function parseStatusline(line: string): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {};
  for (const raw of line.split("•")) {
    const seg = raw.trim();
    if (isEffortArg(seg)) out.effort = seg; // effort is the trailing segment — last match wins
    if (!out.model) {
      if (/opus/i.test(seg)) out.model = /1m/i.test(seg) ? "opus[1m]" : "opus";
      else {
        const fam = MODEL_FAMILIES.find(([re]) => re.test(seg));
        if (fam) out.model = fam[1];
      }
    }
  }
  return out;
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
  if (res.statusline) Object.assign(res, parseStatusline(res.statusline));
  return res;
}

/** Outcome of a send; `reason` is set only on rejection (nothing was sent). */
export type SendResult = {
  ok: boolean;
  reason?: "no-pane" | "no-question" | "no-prompt" | "no-session" | "rewind-unavailable" | "rewind-mismatch" | "rewind-mode" | "bad-image" | "bad-selection" | "no-confirm" | "no-repo" | "no-transcript" | "resume-failed" | "not-found";
  /** Fresh session id, set by createSession to the dictated id. */
  sessionId?: string;
};

/**
 * Launch a new Claude session in `repoPath` as a new tmux window (TUI parity with the
 * `n` wizard's simple case — current branch, no worktree). Rejects when no main tmux
 * session is resolvable (e.g. the bridge is running outside tmux).
 *
 * Mints the session id up front (`crypto.randomUUID()`) and dictates it via
 * `claude --session-id <uuid>`, returning it directly — no waiting on the SessionStart
 * hook. This is deterministic (the caller opens exactly this session) and sidesteps the
 * discovery heuristics that, during the boot window, can mis-map the not-yet-registered
 * pane to a recently-modified existing session (the mtime fallback in
 * enrichUnmatchedSessions). We still wait for the statusline to render so an instant
 * phone message doesn't drop into the boot window.
 */
// Claude Code's one-time "Is this a project you trust?" gate for an untrusted
// folder (`hasTrustDialogAccepted:false` in ~/.claude.json). It blocks boot and
// suppresses the SessionStart hook, so the pane→session id never registers and the
// launch silently hangs — most commonly for the `~` home dir. The caller explicitly
// chose this folder, so we accept it: option 1 ("Yes, I trust this folder") is the
// default cursor, so a single Enter confirms.
const TRUST_PROMPT = "Is this a project you created or one you trust";

export async function createSession(repoPath: string, name: string): Promise<SendResult> {
  const target = await getMainSession();
  if (!target) return { ok: false, reason: "no-session" };
  const sessionId = crypto.randomUUID();
  const paneId = await launchClaudeWindow(target, repoPath, name, sessionId);
  // We minted the id, so the pane→session map is known now — write it ourselves so a phone
  // send resolves the pane immediately, without waiting on the SessionStart hook's write.
  await savePaneSessions({ [paneId]: sessionId });
  let trusted = false;
  for (let i = 0; i < 24; i++) {
    await Bun.sleep(500); // up to ~12s for claude to boot and render its prompt
    // Statusline rendered = prompt live/sendable, so an instant phone message doesn't drop
    // into the boot window (mirrors restoreSession's gate).
    if ((await readPaneStatusline(paneId)).statusline) return { ok: true, sessionId };
    // Accept the trust gate once if it's showing; then keep waiting for the prompt.
    if (!trusted && (await capturePane(paneId)).includes(TRUST_PROMPT)) {
      await sendKey(paneId, "Enter");
      trusted = true;
    }
  }
  return { ok: true, sessionId }; // launched; statusline slow to render (residual, matches restoreSession)
}

/**
 * Whether an archived session can be resumed from the phone: its original repo dir must
 * still exist as a directory AND its transcript JSONL must still be on disk. `claude
 * --resume` is project-cwd-scoped, so a missing/renamed repo makes resume impossible, and a
 * deleted transcript makes it meaningless. Cheap disk checks (one `stat` via Bun.file — NOT
 * `Bun.file().exists()`, which is false for directories); the phone hides the Restore button
 * when this is false. Never throws.
 */
export async function canRestore(sessionId: string, repoPath: string): Promise<boolean> {
  if (!(await isDirectory(repoPath))) return false;
  return (await resolveTranscriptPath(sessionId)) !== null;
}

/** True iff `path` exists and is a directory. Bun-native stat, guarded (mirrors tailRecords). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Bun.file(path).stat()).isDirectory();
  } catch {
    return false; // missing path / stat failure
  }
}

/**
 * Resume an archived session from the phone: launch `claude --resume=<id>` in its original
 * repo dir as a new tmux window and BLOCK until it's ready to drive. Registration (the
 * SessionStart hook writing paneId→sessionId) is the SUCCESS signal — a resume that never
 * registers within the cap failed (bad id / boot error) and returns `resume-failed` rather
 * than a false `ok`. Once registered, we keep polling until the pane's statusline renders
 * (prompt live / sendable) so a message the phone sends the instant it opens the session
 * lands instead of dropping into the boot window (verified: a send at registration-time,
 * before the prompt, is silently swallowed). `repoPath` comes from the caller (server
 * discovery), mirroring `createSession`.
 */
export async function restoreSession(sessionId: string, repoPath: string): Promise<SendResult> {
  if (!(await isDirectory(repoPath))) return { ok: false, reason: "no-repo" };
  if ((await resolveTranscriptPath(sessionId)) === null) return { ok: false, reason: "no-transcript" };
  const target = await getMainSession();
  if (!target) return { ok: false, reason: "no-session" };
  const name = repoPath.split("/").filter(Boolean).pop() ?? "claude";
  const paneId = await launchResumeWindow(target, repoPath, name, sessionId);

  let registered = false;
  let trusted = false;
  for (let i = 0; i < 24; i++) {
    await Bun.sleep(500); // up to ~12s for claude to boot, fire SessionStart, and reach the prompt
    if (!registered && (await loadPaneSessions())[paneId] === sessionId) registered = true;
    if (registered && (await readPaneStatusline(paneId)).statusline) return { ok: true, sessionId };
    // Clear the one-time "trust this folder?" gate. On RESUME (unlike a new session) the
    // SessionStart hook can fire — registering the pane — while the trust prompt is still up
    // and blocking the statusline/input, so this is NOT gated on `!registered`: check every
    // cycle until the statusline confirms the prompt is live. Option 1 ("Yes, I trust this
    // folder") is the default cursor → one Enter confirms.
    if (!trusted && (await capturePane(paneId)).includes(TRUST_PROMPT)) {
      await sendKey(paneId, "Enter");
      trusted = true;
    }
  }
  // Registered but the prompt never rendered in time → launched, just slow (small residual
  // send-drop risk, matches createSession). Never registered → the resume itself failed.
  return registered ? { ok: true, sessionId } : { ok: false, reason: "resume-failed" };
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
    // A session's cwd can move between project dirs (e.g. worktree → base repo), leaving
    // the SAME id as a JSONL in several dirs. Pick the most-recently-written so readers
    // (transcript, mark-read, restore) follow the live conversation, not a frozen copy.
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

// ---------------------------------------------------------------------------
// Subagents — drill-in conversations for `Agent`/`Task` fan-out. Read-only over the
// `<sessionId>/subagents/` directory that sits beside the main transcript JSONL.
// The directory is the only 100%-coverage source: Workflow-/nested-spawned agents
// have no main-transcript chip, so we list from disk, never from the active branch.
// ---------------------------------------------------------------------------

/** The `subagents/` directory beside a session's transcript (`…/<id>.jsonl` → `…/<id>/subagents`). */
export function subagentsDir(transcriptPath: string): string {
  const base = transcriptPath.endsWith(".jsonl") ? transcriptPath.slice(0, -6) : transcriptPath;
  return `${base}/subagents`;
}

// agentIds are hex filename stems today; the charset rejects `/`,`.`,`_` so a decoded
// path segment can never traverse out of the subagents dir (the only `_`-bearing files,
// `aside_question-*`, have no meta and are never listed).
const AGENT_ID_RE = /^[a-z0-9-]+$/;

/** Guard for a path-segment agentId — blocks traversal (`/`,`.`,`_`); see AGENT_ID_RE. */
export function isValidAgentId(agentId: string): boolean {
  return AGENT_ID_RE.test(agentId);
}

interface TailRecord {
  type?: string;
  message?: { content?: unknown };
}

const TAIL_START = 65536; // 64KB initial window
const TAIL_CAP = 4 * 1024 * 1024; // 4MB ceiling — final records reach ~99KB; this is slack

/**
 * Backward chunked tail-read of a JSONL file: parse the complete records at its END
 * without reading the whole thing. Starts at the last 64KB and doubles the window (up
 * to 4MB) until ≥1 complete record is recovered — a subagent's final record can reach
 * ~99KB, so a fixed window would truncate it and misclassify a done agent as running.
 * When we didn't read from byte 0 the first line is a partial record (dropped); a
 * half-written trailing line is skipped by the per-line try/parse. Returns [] on a
 * missing/unreadable file or when the final record exceeds the 4MB cap.
 */
async function tailRecords(path: string): Promise<TailRecord[]> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (!size) return [];
    for (let window = TAIL_START; ; window *= 2) {
      const start = Math.max(0, size - window);
      const text = await file.slice(start, size).text();
      const lines = text.split("\n");
      if (start > 0) lines.shift(); // first line is a partial record — drop it
      const records: TailRecord[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line) as TailRecord);
        } catch {
          // torn trailing fragment (file mid-write) — skip
        }
      }
      if (records.length > 0 || start === 0 || window >= TAIL_CAP) return records;
    }
  } catch {
    return []; // missing/unreadable
  }
}

// A done agent's jsonl is terminal/immutable, so its (size, mtime) never changes again —
// cache that verdict to bound re-reads to still-running agents. `running` is never cached
// (the file is still growing).
const subagentDoneCache = new Map<string, { size: number; mtimeMs: number }>();

/**
 * A subagent's status from its OWN jsonl — `done` iff the last conversational record is an
 * `assistant` turn whose last content block is `text`; else `running`. Validated against
 * ≈680 agents (0 false positives): this rescues the 22% of done agents whose `stop_reason`
 * is `null`, while a running tail is always a `thinking`-only assistant turn or a
 * `tool_result` user record (a tool-calling turn ends in `tool_use`, never `[…text]`). A
 * killed agent that never wrote a terminal turn reads `running` (accepted in v1).
 */
export async function subagentStatus(jsonlPath: string): Promise<"done" | "running"> {
  let stat: { size: number; mtimeMs: number } | null;
  try {
    stat = await Bun.file(jsonlPath).stat();
  } catch {
    return "running"; // missing/unreadable → not yet terminal
  }
  if (!stat) return "running";
  const cached = subagentDoneCache.get(jsonlPath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return "done";

  const records = await tailRecords(jsonlPath);
  let last: TailRecord | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r && (r.type === "user" || r.type === "assistant")) {
      last = r;
      break;
    }
  }
  const content = last?.type === "assistant" ? last.message?.content : undefined;
  const blocks = Array.isArray(content) ? (content as Array<{ type?: string }>) : [];
  const done = blocks.length > 0 && blocks[blocks.length - 1]?.type === "text";
  if (done) subagentDoneCache.set(jsonlPath, { size: stat.size, mtimeMs: stat.mtimeMs });
  return done ? "done" : "running";
}

interface SubagentMeta {
  agentType?: unknown;
  description?: unknown;
  spawnDepth?: unknown;
}

/**
 * List a session's subagents from its `subagents/` directory: one entry per
 * `agent-<id>.meta.json`, with `status` read from the agent's own jsonl. Sorted by
 * `(spawnDepth ?? 1, description)` for a stable order. Never throws — a missing dir or
 * unreadable meta yields [] / a skipped row.
 */
export async function listSubagents(transcriptPath: string): Promise<SubagentSummary[]> {
  const dir = subagentsDir(transcriptPath);
  const out: SubagentSummary[] = [];
  try {
    for await (const name of new Glob("agent-*.meta.json").scan({ cwd: dir })) {
      const agentId = name.slice("agent-".length, -".meta.json".length);
      if (!agentId) continue;
      let meta: SubagentMeta;
      try {
        meta = JSON.parse(await Bun.file(`${dir}/${name}`).text()) as SubagentMeta;
      } catch {
        continue; // corrupt/unreadable meta — skip this row
      }
      const status = await subagentStatus(`${dir}/agent-${agentId}.jsonl`);
      const summary: SubagentSummary = {
        agentId,
        agentType: typeof meta.agentType === "string" ? meta.agentType : "agent",
        description: typeof meta.description === "string" ? meta.description : "",
        status,
      };
      if (typeof meta.spawnDepth === "number") summary.spawnDepth = meta.spawnDepth;
      out.push(summary);
    }
  } catch {
    return []; // missing dir / scan failure
  }
  out.sort(
    (a, b) => (a.spawnDepth ?? 1) - (b.spawnDepth ?? 1) || a.description.localeCompare(b.description),
  );
  return out;
}

// The opening user turn of a subagent is the (often huge) task brief; cap it so the
// drill-in payload stays small — the body (the agent's actual work) is what matters.
const OPENING_TURN_CAP = 2048;

export function capOpeningTurn(turns: TranscriptTurn[]): void {
  const first = turns[0];
  if (!first || first.role !== "user") return;
  first.content = first.content.map((b) =>
    b.type === "text" && b.text.length > OPENING_TURN_CAP
      ? { type: "text", text: `${b.text.slice(0, OPENING_TURN_CAP)}… (truncated)` }
      : b,
  );
}

/**
 * A subagent's full conversation for the drill-in view: `slimTurns(parseTranscript(...))`
 * over `subagents/agent-<agentId>.jsonl`. Linear parse (every subagent record is
 * `isSidechain`, so `parseActiveBranch` falls back to linear anyway). Returns null on a
 * bad agentId (traversal guard), an unresolvable session, or a missing/unreadable file.
 */
export async function getSubagentTranscript(
  sessionId: string,
  agentId: string,
): Promise<SessionTranscript | null> {
  if (!isValidAgentId(agentId)) return null;
  const path = await resolveTranscriptPath(sessionId);
  if (!path) return null;
  let raw: string;
  try {
    raw = await Bun.file(`${subagentsDir(path)}/agent-${agentId}.jsonl`).text();
  } catch {
    return null; // missing/unreadable subagent jsonl
  }
  const turns = slimTurns(parseTranscript(raw));
  capOpeningTurn(turns);
  return { turns };
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
  if (pendingTool?.questions) result.openQuestions = pendingTool.questions;
  return result;
}

// Per-path cache of the parsed active branch, keyed by the file's size+mtime. Any change
// to a JSONL — append OR rewind (which still appends a new branch) — grows the file and
// bumps mtime, so an unchanged (size, mtime) pair means unchanged content: re-use the
// parse instead of re-reading and re-parsing a multi-MB log on every refresh.
const branchCache = new Map<string, { size: number; mtimeMs: number; turns: TranscriptTurn[] }>();

async function readActiveBranchCached(path: string): Promise<TranscriptTurn[]> {
  try {
    const file = Bun.file(path);
    const stat = await file.stat();
    if (!stat) return [];
    const hit = branchCache.get(path);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.turns;
    const turns = parseActiveBranch(await file.text());
    branchCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, turns });
    return turns;
  } catch {
    return []; // missing/unreadable transcript — no turns
  }
}

/**
 * Aggregate a live session's transcript view: ordered turns + last assistant text +
 * the pending tool/question (sourced from the hook log, A3 — pending interactions
 * are not in the transcript before they resolve).
 */
export async function getTranscript(sessionId: string): Promise<SessionTranscript> {
  const path = await resolveTranscriptPath(sessionId);
  // Reconstruct the ACTIVE conversation branch (see `parseActiveBranch`): the JSONL is a
  // tree, and a rewind/edit can SHRINK the logical conversation, so an append-only
  // byte-delta would leak abandoned-branch turns. We read the whole file and rebuild the
  // leaf→root path each time, always returning a full replacement (no cursor). The full
  // re-parse is gated behind a size+mtime cache (any change grows the file), so an idle
  // session re-uses the prior parse instead of re-reading a multi-MB log every refresh.
  const turns = path ? await readActiveBranchCached(path) : [];
  const result = buildSessionTranscript(slimTurns(turns), pendingToolCall(sessionId));
  if (path) {
    // Reuse the size+mtime the cached read just stat()'d — no extra syscall (see branchCache).
    const entry = branchCache.get(path);
    if (entry) result.rev = `${entry.size}:${entry.mtimeMs}`;
    const usage = await readContextUsage(path);
    if (usage) result.usage = usage;
    // Source subagents from the directory beside the transcript (already-resolved path —
    // no second glob). Omitted entirely when the session fanned out to none.
    const subagents = await listSubagents(path);
    if (subagents.length > 0) result.subagents = subagents;
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

/**
 * Archive a session from the phone: kill its live tmux pane (ending the Claude
 * process and closing the window), mirroring the TUI's `x` action. The conversation
 * JSONL is untouched, so the session stays resumable from the Mac (`claude -r`).
 *
 * Fails on no-pane (not silently idempotent): a session that shows as active but whose
 * pane can't be resolved is a discovery mismatch, not a done deal — swallowing it as
 * success made the row look archived while it kept reappearing. Surface it so the phone
 * flashes the failure instead of pretending it worked.
 */
export async function archiveSession(sessionId: string): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  await killPane(paneId);
  return { ok: true };
}

/**
 * Interrupt a running turn by sending `Escape` to the pane — the TUI's own stop key
 * (also used by `rewindByPane`). Fails on no-pane (like `sendMessage`/`answerSessionQuestion`,
 * not idempotent like `archiveSession`): this is a send-keys-to-a-live-pane op.
 *
 * Note: an interrupt fires NO `Stop` hook, so the event-sourced status latches at
 * "running". Claude's native status file (`nativeStatus`, the primary source) de-latches
 * it to "ready" ~1.5s later; the bridge's `/interrupt` route pushes that flip via SSE.
 */
export async function interruptSession(sessionId: string): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  await sendKey(paneId, "Escape");
  return { ok: true };
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

/** One step in the full send plan — the message steps plus the draft stash/restore guard. */
export type SendStep =
  | { kind: "stash" } // cut a Mac-side draft into Claude's kill-ring (C-u) before sending
  | { kind: "text"; text: string } // text-only: the proven coalescing-safe literal+Enter
  | { kind: "paste"; text: string } // bracketed-paste an image path → [Image #N]
  | { kind: "literal"; text: string } // type caption text literally
  | { kind: "submit" } // verify-retry Enter after image paste(s)
  | { kind: "restore" }; // after the prompt clears, paste the stashed draft back (C-y)

/**
 * Pure builder for the complete tmux interaction of a send (extracted for testability,
 * mirroring `composeMessageSteps` / `questionAnswerKeys`). This is where the keystroke
 * ORDER and the draft-guard GATING live — the part worth locking down — leaving
 * `runSendStep` a thin map from step → tmux call.
 *
 * Body: text-only stays the single coalescing-safe `text` step (NOT the image submit-loop,
 * whose paste-ingestion retry is unnecessary for plain text and would change proven
 * behavior). With images, `composeMessageSteps`' paste/literal steps pass through and its
 * terminal `enter` becomes the verify-retry `submit`.
 *
 * Draft guard: the Mac may be attached with a half-typed draft in the prompt. A bare send
 * types our message onto the END of that draft and submits BOTH as one turn. So when a
 * draft is present we wrap the body in `stash` (cut the draft into Claude's kill-ring with
 * C-u) … `restore` (once our message clears the prompt, yank the draft back with C-y) —
 * leaving it waiting, unsubmitted, for when the user returns to the Mac. Gated on a real
 * draft so we never yank stale kill-ring content into an otherwise-empty prompt.
 */
export function buildSendPlan(
  text: string,
  imagePaths: string[],
  hadDraft: boolean,
): SendStep[] {
  const body: SendStep[] =
    imagePaths.length === 0
      ? [{ kind: "text", text }]
      : composeMessageSteps(text, imagePaths).map((s): SendStep =>
          s.kind === "enter" ? { kind: "submit" } : s,
        );
  return [
    ...(hadDraft ? [{ kind: "stash" } as const] : []),
    ...body,
    ...(hadDraft ? [{ kind: "restore" } as const] : []),
  ];
}

/** Execute one `SendStep` against the pane — the thin, effectful tmux wrapper. */
async function runSendStep(paneId: string, step: SendStep): Promise<void> {
  switch (step.kind) {
    case "stash":
      await sendKey(paneId, "C-u"); // Claude's kill-line: clears the input, holds it for C-y
      await Bun.sleep(KEY_GAP);
      return;
    case "text":
      await sendTextAndEnter(paneId, step.text);
      return;
    case "paste":
      await sendBracketedPaste(paneId, step.text);
      await Bun.sleep(KEY_GAP);
      return;
    case "literal":
      await sendLiteral(paneId, step.text);
      await Bun.sleep(KEY_GAP);
      return;
    case "submit":
      // The Enter after an image paste is dropped if the TUI is still ingesting the pasted
      // image (base64-embedded at paste time) — reliably so on a session's first message
      // right after boot. Settle, press Enter, confirm the input cleared; resend if pending.
      await Bun.sleep(KEY_GAP);
      for (let i = 0; i < 4; i++) {
        await sendKey(paneId, "Enter");
        await Bun.sleep(450);
        if (!inputPending(await capturePane(paneId))) break;
      }
      return;
    case "restore":
      // Yank ONLY after our message clears the prompt — a premature C-y would paste the
      // draft into the not-yet-submitted input and ride along with our message.
      for (let i = 0; i < 8; i++) {
        if (!inputPending(await capturePane(paneId))) break;
        await Bun.sleep(KEY_GAP);
      }
      await sendKey(paneId, "C-y"); // Claude's yank: re-adds the draft cut by the stash C-u
      return;
  }
}

/**
 * Send a message (optional images + optional text) to a session's pane — TUI parity: the
 * TUI sends keys unconditionally, so the bridge does too (Claude Code queues input while
 * running, accepts it at the prompt). The ONLY gate is a live pane. Blocked-on-question/
 * permission states are steered to the structured answer/approval UI client-side.
 *
 * Thin executor over `buildSendPlan` (where the ordering + draft-guard logic is tested):
 * resolve the pane, snapshot whether a draft is present, then run each planned step.
 */
export async function sendMessage(
  sessionId: string,
  text: string,
  imagePaths: string[] = [],
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  const hadDraft = inputPending(await capturePane(paneId));
  for (const step of buildSendPlan(text, imagePaths, hadDraft)) {
    await runSendStep(paneId, step);
  }
  return { ok: true };
}

/**
 * Pull Claude's `Set model to …` / `Set effort level to …` confirmation out of a pane
 * capture, JOINING wrapped continuation lines first (a long confirmation wraps on a narrow
 * pane — see the width caveat in tmux.ts — and would otherwise truncate the toast). A
 * continuation is an indented, non-empty line that doesn't open a new block (`⎿`/`❯`) or a
 * glyph/status line. Returns the whitespace-collapsed sentence, or null if none is present.
 */
export function extractConfirmation(capture: string): string | null {
  const lines = capture.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/Set (?:model|effort level) to .+/);
    if (!m) continue;
    let text = m[0]!;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      if (!next.trim()) break; // blank line ends the block
      if (/^\s*[❯⎿│•·>]/.test(next)) break; // new block / statusline / hint glyph
      if (!/^\s{2,}/.test(next)) break; // continuations stay indented under the ⎿
      text += " " + next.trim();
    }
    return text.replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * Switch a live session's model or reasoning effort from the phone. Sends the arg-form
 * slash command (`/model <x>`, `/effort <x>`) through the same draft-safe send path as
 * `sendMessage`, then POLLS the pane for Claude's confirmation line (variable latency,
 * mirroring `rewindByPane`) and returns it verbatim for the caller to surface. Scope is
 * Claude's to decide — global default for model + normal effort, session-only for
 * `ultracode` — so we report its exact wording rather than asserting a scope ourselves.
 * Callers validate `value` against MODEL_ARGS/EFFORT_ARGS before calling.
 */
export async function setSessionModelEffort(
  sessionId: string,
  kind: "model" | "effort",
  value: string,
): Promise<SendResult & { line?: string }> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  const hadDraft = inputPending(await capturePane(paneId));
  for (const step of buildSendPlan(`/${kind} ${value}`, [], hadDraft)) {
    await runSendStep(paneId, step);
  }
  for (let i = 0; i < 12; i++) {
    const line = extractConfirmation(await captureAfter(paneId, 200));
    if (line) return { ok: true, line };
  }
  return { ok: false, reason: "no-confirm" };
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
 * route to `decideApproval`, never here). The decision-file channel is tried FIRST:
 * when the focus-aware PreToolUse hook is holding this question, `decideQuestion`
 * resolves it via `updatedInput.answers` (no live pane needed). Only the un-intercepted
 * (native-widget) case — not tracked, no live phone, or focused — falls through to
 * send-keys, which does need a pane. Rejects when no question is open or the length is off.
 */
export async function answerSessionQuestion(
  sessionId: string,
  selections: (number | number[])[],
): Promise<SendResult> {
  const pending = pendingToolCall(sessionId);
  if (!hasOpenQuestion(pending)) return { ok: false, reason: "no-question" };
  // One selection per question — a length mismatch means the client is out of sync
  // with the live prompt; reject before sending any keystroke to a wrong tab.
  const questions = pending!.questions ?? [pending!.question!];
  if (selections.length !== questions.length) return { ok: false, reason: "bad-selection" };
  // Intercepted by the hook → answer via the decision file, no pane required.
  if (decideQuestion(sessionId, pending!.toolUseId, buildAnswersMap(questions, selections))) {
    return { ok: true };
  }
  // Un-intercepted (native widget) → drive the live pane.
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  await answerQuestion(paneId, selections);
  return { ok: true };
}

/**
 * Approve/deny an ATTACHED session's on-screen tool permission prompt by driving the pane
 * directly — the detached decision-file channel doesn't exist for attached sessions (the
 * PreToolUse hook exits neutral so the instant desk prompt shows). Mirrors the TUI's own
 * handling: allow presses Enter (option 1 "Yes" is pre-selected), deny presses Escape.
 * Guards on the prompt still being up so a resolved/absent prompt no-ops instead of
 * injecting a stray key into the composer (the caller routes here only when no file-pending
 * approval exists, so a race where the desk already answered lands on `no-prompt`).
 */
export async function decideAttachedApproval(
  sessionId: string,
  decision: "allow" | "deny",
): Promise<SendResult> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return { ok: false, reason: "no-pane" };
  if (!isPermissionPrompt(await capturePane(paneId))) return { ok: false, reason: "no-prompt" };
  await sendKey(paneId, decision === "allow" ? "Enter" : "Escape");
  return { ok: true };
}
