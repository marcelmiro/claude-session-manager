# Contracts — Headless `core/` API (handoff to Impl #3)

By the end of Impl #2, `core/` exposes these framework-agnostic, headless
functions. Impl #3's bridge builds directly on them and adds **no** new
Claude-wrapping logic. Two are pinned by the RED contract tests; the rest are new
or changed surface.

## Types (`src/types.ts`)

`HookEvent` is the **raw Claude Code hook payload, verbatim** (snake_case) — this
is mandatory: `event-status.test.ts` casts the committed fixtures
(`fixtureJson("hooks/*.json") as HookEvent`) and feeds them straight to
`deriveStatus`. The event log stores these payloads one-per-line, so `readEvents`
returns the same shape with no translation layer. **Export paths the tests pin:**
`HookEvent` is exported from `src/core/event-status.ts` (`:22`), and
`TranscriptTurn`/`TranscriptBlock` from `src/core/transcript.ts` (`:24-29`).
Per the repo convention, define all three in `src/types.ts` and `export type {…}`
re-export from each core module to satisfy the test import paths.

```ts
// Raw hook payload — one JSON object per line in events/<session_id>.jsonl
interface HookEvent {
  session_id: string;
  hook_event_name: "SessionStart" | "UserPromptSubmit" | "PreToolUse"
                 | "PostToolUse" | "Notification" | "Stop" | "SubagentStop";
  transcript_path: string;    // absolute path to the JSONL transcript (free on every event)
  cwd: string;
  permission_mode?: string;
  effort?: { level: string };
  tool_name?: string;         // PreToolUse / PostToolUse
  tool_input?: unknown;       // PreToolUse (AskUserQuestion → { questions: [...] })
  tool_use_id?: string;
  notification_type?: "permission_prompt" | "idle_prompt";
  message?: string;           // Notification
  // unknown keys tolerated (forward-compat across claude versions)
}

// Field is `content` (NOT `blocks`) — transcript.test.ts:14,36 require `t.content`.
// Both types are exported from src/core/transcript.ts (the test imports them from
// "./transcript"); define in src/types.ts and re-export from transcript.ts.
type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

interface TranscriptTurn {
  role: "user" | "assistant";
  content: TranscriptBlock[];   // a string-valued message.content becomes one text block
}

interface PendingApproval {
  sessionId: string; ts: number;
  tool: string; tool_use_id: string; input: unknown;
}
```

## Status (Inc1, widened in Inc4) — pinned by `event-status.test.ts`

```ts
// Inc1 ships the no-opts form (the test only ever calls deriveStatus([...])):
deriveStatus(events: HookEvent[]): SessionStatus
// Inc4 widens it (both types exist by then; keeps Inc1 ⫫ Inc2):
deriveStatus(events: HookEvent[], opts?: { transcript?: TranscriptTurn[] }): SessionStatus
```
Pure function over raw `HookEvent`s in append order (newest last). `SessionStatus =
"running" | "waiting" | "ready" | "idle" | "archived"` (`status.ts:5`). Truth table
in Contract A (doc 01). `opts.transcript` (added in Inc4) powers the missed-edge
backstop only; absent it, derives from edges alone. There is **no** `TranscriptEntry`
type — the backstop consumes `TranscriptTurn[]`.

## Transcript (Inc2) — pinned by `transcript.test.ts`

```ts
parseTranscript(raw: string): TranscriptTurn[]          // tolerant of truncated last line + unknown keys
lastAssistantMessage(turns: TranscriptTurn[]): string | undefined
```
Resolved `AskUserQuestion` surfaces inside a `tool_use` block as
`input.questions[]` (plural, SCHEMA A4). Pending tool/question is **not** here —
it comes from the PreToolUse `HookEvent` (SCHEMA A3).

## Hook events (Inc3)

```ts
readEvents(sessionId: string): HookEvent[]   // read WITHOUT truncation; append order, newest last
```
The writer is the installed hook script (appends the raw payload), not a TS
export. Skips corrupt/half-written lines (per-line `try/parse`, drop on failure).
`processHookEvents()` (`state.ts:104`) is **unchanged** — separate concern
(pane→session map). Because `transcript_path` is on every record, callers get the
transcript location without re-encoding `cwd`.

## Approval IPC (Inc6)

```ts
listPendingApprovals(): PendingApproval[]
decideApproval(sessionId: string, decision: "allow" | "deny", reason?: string): void
```
`decideApproval` writes `decisions/<sessionId>.json`; the blocking PreToolUse hook
polls it and returns `{hookSpecificOutput:{permissionDecision}}`. Only sessions in
the **detached** branch appear in `listPendingApprovals()` (attached desk sessions
get the instant TUI prompt, never block).

## Input (Inc5)

```ts
sendMessage(sessionId: string, text: string): void   // send-keys text+Enter; caller gates on status
answerQuestion(sessionId: string, optionIndex: number | number[]): void   // A8 index nav
```
Free-text enabled only when status is `ready`/waiting-input. `answerQuestion`
uses the option index from the structured question (single vs multiSelect nav per A8).

## Change notification — DEFERRED to Impl #3

A `watch(eventsDir)` debounced change primitive (for the bridge's SSE push) has
**no consumer in Impl #2** (the TUI/monitor already poll on a 3s loop). Building it
now is speculative; it is the first increment of Impl #3 instead. See
[`decisions.md`](./decisions.md) ADR-5.

## Changed surface

- `discoverSessions()` (Inc4) now returns sessions with **event-sourced** status
  (+ optional `statusSource` field); shape otherwise unchanged.
