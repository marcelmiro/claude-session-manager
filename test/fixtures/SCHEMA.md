# Claude Code wrapping — pinned schema (Gate A evidence)

> Captured live on macOS, **Claude Code v2.1.191**, tmux 3.6b, bun 1.3.14
> (2026-06-25) by driving a throwaway session through real scenarios with a
> stdin-dumping hook. These are **observed shapes**, not docs. Fixtures under
> `test/fixtures/` are the raw captures (work-codebase paths scrubbed to
> `/private/tmp`). Re-pin against any new `claude` minor version.

## Hook payloads

**A1 — common envelope (✅ verified).** *Every* hook payload carries
`session_id`, `cwd`, `transcript_path`, `hook_event_name`. Most also carry
`permission_mode` (`default` | `auto` | …) and `effort: { level }`.

| Event | Distinctive fields (beyond the envelope) | Fixture |
|-------|------------------------------------------|---------|
| `SessionStart` | `source` (`startup` \| …) | `hooks/sessionstart.json` |
| `UserPromptSubmit` | `prompt`, `permission_mode` | `hooks/userpromptsubmit.json` |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | `hooks/pretooluse.json` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | `hooks/posttooluse.json` |
| `Notification` | `message`, `notification_type` | `hooks/notification-*.json` |
| `Stop` | `last_assistant_message`, `stop_hook_active`, `background_tasks`, `session_crons` | `hooks/stop.json` |

**A2 — Notification discrimination (✅ verified).** The discriminator is
`notification_type`, with two observed values:
- `permission_prompt` — message `"Claude needs your permission"`
- `idle_prompt` — message `"Claude is waiting for your input"` (fires ~60s idle)

**A6 — attach-aware blocking PreToolUse hook (✅ verified, contained spike).**
PreToolUse carries the approval-card data (`tool_name`/`tool_input`/`tool_use_id`
+ envelope) — render the card without the transcript. Control the decision by
printing to stdout:

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "..." } }
```

- `allow` / `deny` **suppress** the interactive TUI prompt (tool runs / is blocked;
  the `deny` reason is shown to Claude). `ask` (or exit 0 with no JSON) **falls
  through** to the normal TUI prompt.
- Claude **blocks** waiting for the hook to exit. Default timeout **600s**;
  per-hook `"timeout": <s>` in the hook config. Exit 2 = hard block (stderr → Claude).
- **Attach-aware branch** (the design): the hook derives its session from
  `$TMUX_PANE` (`tmux display-message -p -t "$TMUX_PANE" '#{session_name}'`) and
  checks `tmux list-clients -t <sess>`. **Non-empty → client attached → return
  `ask`** (instant desk prompt, no block). **Empty → detached → block-and-poll** a
  decision file, then `allow`/`deny` (or `ask` on timeout). Verified both ways
  end-to-end: detached + a remotely-written `allow` ran the tool; attached gave an
  instant desk prompt. This also arbitrates the desk/phone double-approval race —
  only one surface is ever live for a given prompt.

> Tested in a **project-scoped** `.claude/settings.json` under a throwaway dir
> (since removed), confirmed to fire **only** for sessions in that dir — never the
> global config — so it could not intercept real sessions.

## Transcript (`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`)

**A10 — path mapping (✅ verified).** `encoded-cwd` = the absolute cwd with every
`/` replaced by `-` (e.g. `/private/tmp` → `-private-tmp`). Confirmed by deriving
a live session's transcript path from its cwd.

**A5 — line discriminators (✅ verified; kills the inferred `user_message`).**
Top-level `type` values observed: conversational — **`user`**, **`assistant`**;
meta (ignore when parsing turns) — `mode`, `permission-mode`,
`file-history-snapshot`, `attachment`, `last-prompt`, `system`, `ai-title`.
Conversational records nest an Anthropic **`message`** with `content` that is
either a string or an array of blocks:

- block types: `text`, `thinking`, `tool_use`, `tool_result`
- `tool_use` block (in `assistant`): `{ type, id, name, input }`
- `tool_result` block (in `user`): `{ type, tool_use_id, content, is_error }`
- pair a tool by `tool_use.id === tool_result.tool_use_id`

A parser **must tolerate unknown top-level `type`s and unknown keys** — the meta
record set varies by version.

**A4 — AskUserQuestion shape (⚠️ CORRECTED — plan assumed wrong shape).** The
options are **not** `{ question, options }`. Real `tool_use.input` (and, by the
same path, the pending-state `PreToolUse.tool_input`):

```jsonc
{ "questions": [                       // ← ARRAY, plural
    { "question": "…", "header": "…", "multiSelect": false,
      "options": [ { "label": "…", "description": "…" } ] }
] }
```

Contract B must surface `questions[].options[].{label,description}`, not a single
`{question, options}`. Fixtures: `transcripts/askuserquestion.jsonl` (resolved),
`hooks/pretooluse-askuserquestion.json` + `…-multiselect.json` (pending source).

**A8 — answering via `send-keys` (✅ verified end-to-end).** The pending question
data is in the `PreToolUse` hook (`tool_input.questions[]`), so the bridge knows
the options before answering. Inject the answer by index:

- **single-select:** `↓` × `optionIndex`, then `Enter`. The on-screen menu lists
  the real options first (1..N from `questions[0].options`), followed by two
  synthetic entries ("Type something", "Chat about this") — index against the
  real options.
- **multiSelect:** `↓` to each desired option + `Space` to toggle (checkbox flips
  `[ ]`→`[✔]`), then `→` to the **Submit** tab + `Enter`. Note: `Enter` on an
  option only toggles it — it does **not** submit; submission is the Submit tab.
- **confirm, never assume:** the result lands on the event stream — the transcript
  `tool_result` (`"…"="<label>"`) and `PostToolUse.tool_response.answers`
  (`{ "<question text>": "<label>" }`; multiSelect value is comma-joined labels,
  e.g. `"Cheese, Onion"`). The bridge gates the send on event-status and confirms
  via this stream rather than optimistically.

**A3 — pending tool is NOT in the transcript before approval (❌ CONTRADICTS
plan/doc 00).** While a permission prompt is displayed, the transcript contains
the `user` prompt but **no assistant `tool_use` record**; the `tool_use` (and its
`tool_result`) appear only *after* the decision. Verified by reading the live
transcript while the `touch` prompt was pending: 12 records, zero `tool_use`.

→ **Architectural consequence:** *pending* interaction data (a tool awaiting
approval, or an unanswered AskUserQuestion) must be sourced from the
**`PreToolUse` hook payload** (`tool_name` / `tool_input`), **not** the
transcript. The transcript is authoritative only for *resolved* history. doc 00
§"two problems" #2 ("pending tool calls are structured data in the JSONL
transcript") is false for the pending state and is corrected accordingly.

## Viewport (`capture-pane`) — the bug this project fixes

**Capture mode matters.** `viewport/running.txt` is a raw `capture-pane -e`
(ANSI) capture — correct for preview-pane/SGR tests. `detectStatus` expects
**ANSI-stripped** input (production strips it in `sessions.ts:389-392` before
calling); fed the raw `-e` text it falls through to `ready` because the spinner
line is prefixed by escape sequences and fails the `^[spinner]` anchor.
`viewport/running.plain.txt` is the stripped form used for status tests. Impl #2
should extract that strip into a shared helper.

**B3 — scroll-up misread (✅ reproduced with a real capture).** The non-scrolled
running viewport (`viewport/running.plain.txt`) shows `✽ Optimus Priming… (…)`
above the `❯` prompt → `detectStatus` = `running`. The **mechanism** (captured
live, `viewport/running-scrolled-up.txt` raw / `…-scrolled-up.plain.txt` stripped):
Claude's TUI is fullscreen (alternate screen); scrolling is **internal**
(`PageUp` / `Ctrl+Home` — not tmux copy-mode, which can't reach the alt-screen).
When the user scrolls up during a running turn, Claude repaints history into the
middle of the viewport, **keeps the `❯` input prompt pinned at the bottom, but
replaces the spinner line with `Jump to bottom (ctrl+End) ↓`**. So `detectStatus`
still finds the prompt, looks above it, finds no spinner, and falls through to
`ready` — even though the process is running. Verified:
`detectStatus(scrolled, hasProcess=true)` → `ready` (the bug); the non-scrolled
control → `running`. This single contrast defines the migration's success.
