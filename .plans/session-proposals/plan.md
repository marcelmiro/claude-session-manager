# Session proposals (agent-proposed follow-up sessions)

## Summary

Let a running Claude Code session propose spinning up an independent follow-up session via a custom MCP tool `propose_session({ title, prompt, rationale? })`. A hand-rolled stdio MCP server (`csm mcp`, installed globally by `csm setup`) receives the call, writes an atomic proposal file to `~/.config/csm/proposals/<id>.json` (repo = the session's cwd), and fires a macOS notification. The bridge exposes `GET /proposals`, `POST /proposals/:id/approve`, `POST /proposals/:id/reject`, and file-watches the proposals dir to push an SSE `proposals-changed` event. The web app renders each proposal as an Approve/Edit/Reject card; Approve calls `createSession(repoPath, name, prompt)` to launch `claude` in the same repo dir with the prompt seeded, then deletes the proposal. Approval lives only on the web app; the Mac side is notification-only. Because launch is in-place (no worktree/branch), the only spawn-primitive gap is prompt-seeding — `createSession` gains an optional `prompt` param (seeded via the existing `sendMessage` after the SessionStart poll resolves the id); that ~10-line extension is **in scope** here.

## Data model changes

- **Change:** New ephemeral queue dir `~/.config/csm/proposals/`, one JSON file per proposal: `{ id, sessionId, repo, title, prompt, rationale?, createdAt }`. Mirrors the existing `pending/` (`approval.ts:19`) and `panes/` per-file atomic-write pattern.
- **Migration:** N/A — new dir, created lazily on first write (`mkdir -p`), like `EVENTS_DIR`.
- **Constraints/indexes affected:** none.
- **Query patterns affected:** bridge reads the dir (`GET /proposals`) and deletes files on approve/reject; MCP handler writes; a bridge `fs.watch` on the dir drives SSE.
- **Backwards compat:** additive; absence of the dir is a no-op (empty list, watcher no-ops like `watchEvents`).
- **Backfill:** N/A — transient queue, no historical rows.
- **Rollback:** delete the dir; remove the MCP server entry (`claude mcp remove csm`).

## Files to touch

Increment order: (0) MCP wire-format spike → (1) `proposals.ts` + `session-api.ts` prompt param → (2) `mcp.ts` + install → (3) bridge routes/watch → (4) web UI.

### Increment 0 — MCP wire-format spike (blocking, do first)

Before writing `mcp.ts`, capture the exact frames Claude Code's MCP client expects: the `initialize` request/response + capability negotiation, the `notifications/initialized` follow-up, the `tools/list` result JSON-schema shape, and the `tools/call` result envelope. Register a throwaway echo server via `claude mcp add`, connect a session, and log stdin/stdout. Record the wire format inline in `mcp.ts` as the contract before implementing. This is undesigned today and is the core mechanism — treat it as a gate, not a detail.

### src/mcp.ts (new)

Minimal MCP stdio server, no SDK (honors the no-external-deps rule). Reads line-delimited JSON-RPC 2.0 from stdin per the Increment-0 contract; handles `initialize`, `notifications/initialized`, `tools/list`, `tools/call` for one tool `propose_session` (inputSchema: `title` string, `prompt` string, `rationale` string optional). On `tools/call`: derive `repo = process.cwd()`, `sessionId` from `CLAUDE_SESSION_ID` env if present (else omit), write the proposal via `core/proposals.ts`, fire the macOS notification, return a text result ("Proposal queued — awaiting approval on the csm web app.").

### src/core/session-api.ts

Extend `createSession(repoPath, name, prompt?)` (currently `:116`, no prompt param): after the SessionStart poll resolves `sessionId`, if `prompt` is set call the existing `sendMessage(sessionId, prompt)` (`:807`). No new launch logic — reuses the tested send path. In-place launch only; no branch/worktree params.

### src/core/proposals.ts (new)

`writeProposal(p)` (`mkdir -p PROPOSALS_DIR` inside the fn, then temp+rename atomic write — the dir guarantee lives in the writer, mirroring `state.ts`'s panes writer, not in callers; id from `crypto.randomUUID()`), `listProposals()` (read dir → sorted by `createdAt`), `getProposal(id)`, `deleteProposal(id)`. Export `PROPOSALS_DIR = \`${PATHS.dir}/proposals\`` and the `Proposal` type (co-located, per the `session-api.ts` type-locality convention). Traversal-guard `id` on read/delete (reuse the pattern in `getSubagentTranscript`).

### src/core/notifications.ts

Extract/export a `notifyMac(title, body)` helper wrapping the existing terminal-notifier→osascript dispatch (currently inline around `notifications.ts:143-159`) so the MCP handler can reuse it. No behavior change to existing callers.

### bin/csm.ts

Add a `case "mcp": await import("../src/mcp");` branch and a help-text line.

### src/cli.ts

In `setup()`, after the hook install, register the MCP server idempotently: shell `claude mcp add -s user csm -- csm mcp` — invoke through the installed `csm` PATH symlink (`/opt/homebrew/bin/csm`) so it inherits the project's `--env-file=/dev/null` shebang, rather than calling `bun bin/csm.ts` directly. Guard on `claude mcp list` already containing `csm`. Print a line in the setup summary.

### src/bridge/server.ts

Add three protected routes: `GET /proposals` → `json(await listProposals())`; `POST /proposals/:id/approve` (body may carry an edited `prompt`) → **claim first**: `getProposal(id)` then `deleteProposal(id)` *before* spawning; if the file was already gone, return `{ok:false, reason:"already-claimed"}` (removes the double-spawn race). Then call `createSession(proposal.repo, proposal.title, editedPrompt ?? proposal.prompt)`; on `ok` `broadcast({type:"proposals-changed"})` + `broadcast({type:"session-changed"})` and return `sendResult`; on failure re-write the proposal (`writeProposal`) so it isn't silently lost, and surface the reason. `POST /proposals/:id/reject` → `deleteProposal(id)` + `broadcast({type:"proposals-changed"})`. Add a `fs.watch(PROPOSALS_DIR)` (mirror `watchEvents`; no-op if dir absent) wired in the `Bun.serve` bootstrap to `broadcast({type:"proposals-changed"})`.

### src/bridge/public/app.js

On load and on SSE `proposals-changed`, fetch `/proposals` and render a pinned "Proposals" section above the session list. Each card shows title, rationale, and the (editable) prompt with Approve / Edit / Reject buttons → `POST` the matching route. Edit reveals the prompt textarea; Approve sends `{prompt}` when edited. Optimistically remove the card on success; the SSE re-fetch reconciles.

### src/bridge/public/index.html

Markup + CSS for the proposals section and card, using the existing `:root` color tokens (hand-written CSS, no Tailwind — per `bridge-css-no-tailwind`).

## Edge cases

- Proposals dir missing on first write → `writeProposal` does its own `mkdir -p` (dir guarantee lives in the writer, not the MCP caller).
- Approve when the proposal's repo dir no longer exists / `getMainSession()` null → `createSession` returns `{ok:false}`; the claim-first flow re-writes the proposal so it survives, and the card surfaces the reason.
- Two clients approve the same proposal → claim-first (delete before spawn) means the second approve sees the file gone and returns `already-claimed`; exactly one spawn.
- Malformed/partial proposal JSON in the dir → `listProposals` skips unparseable files rather than throwing.
- `claude` CLI absent when `setup()` runs `claude mcp add` → catch, warn, continue (hooks still install).

## Verification

- Run: `bun test` (add `proposals.test.ts`).
- Tests to add/update: `proposals.test.ts` — write→list→get→delete round-trip against a `CSM_HOME` tmpdir; malformed-file skip; traversal-guard rejects `../` ids. Bridge: `/proposals` returns written proposals; approve deletes + calls createSession (mock); reject deletes.
- Manual: run `csm mcp` and pipe a `tools/call` JSON-RPC frame → assert a file lands in `proposals/` and a notification fires. Then load the web app.
- Done when:
  - GIVEN a session with the csm MCP server registered, WHEN Claude calls `propose_session({title,prompt})`, THEN a file appears in `~/.config/csm/proposals/` and a macOS notification fires.
  - GIVEN a pending proposal, WHEN the web app receives the `proposals-changed` SSE, THEN a card with title/rationale/prompt and Approve/Edit/Reject renders without a manual refresh.
  - WHEN Approve is tapped, THEN a new tmux window running `claude` appears in the proposal's repo dir with the prompt seeded, and `GET /proposals` no longer lists it.
  - WHEN Reject is tapped, THEN the proposal file is deleted and the card disappears.

## Decisions and assumptions

- Decision: stdio MCP server installed by `csm setup` via `claude mcp add -s user`. Source: user-confirmed.
- Decision: approval is web-app-only; Mac side is a macOS notification. Source: user-confirmed.
- Decision: approved sessions launch in-place in the proposal's repo dir (no worktree/branch). Source: user-confirmed (sessions won't be launched on conflicting work).
- Decision: repo = the proposing session's `process.cwd()`; the tool takes only `title`/`prompt`/`rationale`. Source: default (keeps the tool surface minimal).
- Decision: hand-roll the minimal MCP JSON-RPC server rather than add `@modelcontextprotocol/sdk`. Source: code @ CLAUDE.md ("No external deps beyond blessed").
- Decision: fold the minimal prompt-seeding extension to `createSession` into this plan (in-scope). The original "precondition already exists" framing was false against the repo — `createSession` (`session-api.ts:116`) takes no `prompt` today. In-place launch means `prompt` is the only gap (no branch/worktree needed). Source: plan-review MUST-FIX + user-confirmed in-place launch.
- Assumption: Claude Code exposes the session id to MCP servers via env (`CLAUDE_SESSION_ID` or similar); if not, `sessionId` is omitted and provenance is dropped for v1. Source: default — verify in Increment 0.

## Standards / common-mistakes referenced

- `bridge-css-no-tailwind` memory — bridge UI stays hand-written CSS with `:root` tokens.
- `core/approval.ts:19` (`PENDING_DIR`) and `state.ts` panes/ — atomic per-file queue pattern to mirror.
- `core/watch.ts` — `fs.watch` + debounce + dir-absent-no-op pattern to mirror for the proposals watcher.

## Estimated scope

M

## Open questions (CONSIDER from review)

- `claude mcp add` idempotency guard parses `claude mcp list` text output — brittle if the CLI format changes. Acceptable for v1; revisit if it breaks.
- Verify in Increment 0 that MCP subprocesses actually receive `CLAUDE_SESSION_ID` (or equivalent); without it, proposals can't be tied back to their originating session (provenance dropped, feature still works).
