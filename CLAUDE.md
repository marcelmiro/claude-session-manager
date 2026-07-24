# CLAUDE.md

# CSM — Claude Session Manager

Full-screen terminal TUI (blessed) for managing Claude Code sessions. Launched via `tmux display-popup`. Shows sessions grouped by repo with live status detection, ANSI preview pane, vim navigation, attention notifications, and AI naming.

## Environment

macOS (ARM) with Ghostty terminal, Oh My Zsh, and tmux.

## Commands

```sh
bun run start             # Run TUI
bun run dev               # Watch mode (--watch)
bun run status            # Lightweight tmux status-right monitor
bun test                  # Run tests (bun:test)
```

Entry: `bin/csm.ts` (CLI router) → `src/index.ts` (TUI) or `src/cli.ts` (subcommands)

## Bridge restarts (do it directly)

The mobile bridge (`csm bridge`) runs as a long-lived detached daemon on `127.0.0.1:8473` (proxied to the phone via `tailscale serve`). **When a change needs a restart, restart it yourself — don't just tell the user.** This is a routine, durably-authorized action on the local machine; treat it as approved.

- **When a restart IS needed:** any change to `src/bridge/server.ts` or the `core/` functions it imports — the server code is loaded into the running Bun process.
- **When it is NOT needed:** changes to `src/bridge/public/*` (`app.js`, `index.html`/CSS). Those are served fresh (`cache-control: no-cache`); the user just refreshes/reopens the page on the phone.
- **How to restart** (preserve the token + the loopback bind so `tailscale serve` keeps working):
  ```sh
  PID=$(pgrep -f "csm bridge" | head -1)
  TOK=$(ps eww -p "$PID" | tr ' ' '\n' | grep '^CSM_BRIDGE_TOKEN=' | cut -d= -f2)   # recover the running token
  kill "$PID"; sleep 1
  CSM_BRIDGE_TOKEN="$TOK" nohup csm bridge > "$HOME/.config/csm/bridge.log" 2>&1 & disown   # detach (PPID 1) so it outlives the session
  ```
  Host/port default to `127.0.0.1:8473` when unset (the usual setup). Then verify: `POST /auth` → 200 and the changed route behaves. The benign `Failed to start server. Is port 8473 in use?` log line is the second `caffeinate`-wrapped instance losing the bind race — ignore it.

## CLI subcommands

`bin/csm.ts` routes based on `process.argv[2]`. All subcommands except `status` live in `src/cli.ts`.

| Command | Description | Output |
|---------|-------------|--------|
| `csm` | Open full TUI (`CSM_FOCUS_PANE` env var pre-selects a pane) | blessed screen |
| `csm next` | Switch to next attention session (oldest first) | tmux display-message |
| `csm reset` | Reset all window names to "claude", clear ⚡ and attention state | tmux display-message |
| `csm status` | Tmux status-right monitor (`⚡3 🔄2`) | stdout |
| `csm list` | Text-only session list with status/repo/context% | stdout |
| `csm switch <name>` | Fuzzy-match session by name and switch to it | tmux display-message |
| `csm setup` | Install SessionStart hook for session tracking | stdout |
| `csm save-sessions` | Snapshot pane→session map for tmux-resurrect | stdout (silent in hook) |
| `csm restore-sessions` | Restore Claude sessions after tmux-resurrect restore | stdout |
| `csm --help` | Show available commands and usage | stdout |

**Testing subcommands**: Use `bun run bin/csm.ts <cmd>` to test without installing globally. Example: `bun run bin/csm.ts list` prints active sessions to stdout — useful for verifying session discovery, status detection, and name resolution without launching the TUI.

**`csm next` details**: Reads `state.json` attention flags, picks the session with the oldest `lastTransition` timestamp, clears its attention flag, strips ⚡ prefix, and calls `switchToPane()`. Falls back to scanning tmux windows for ⚡ prefixes when state.json has no valid candidates (handles state↔window desync).

**`csm reset` details**: Lists all tmux windows, renames any with non-standard names (not in `zsh|bash|dev|fish|sh`) back to repo name from pane cwd. Strips ⚡ and 🔄 prefixes. Also clears all attention flags in `state.json`.

**`csm switch` scoring**: exact=100, starts-with=80, contains=60, word-starts-with=40, subsequence=20. Matches against window names with ⚡/🔄 stripped.

**Focus pane pre-selection**: Set `CSM_FOCUS_PANE=%42` (tmux pane ID) to pre-select that session on launch. Requires `run-shell` to expand the format string: `bind a run-shell 'tmux set-environment CSM_FOCUS_PANE "#{pane_id}"' \; display-popup -E -w 90% -h 85% csm`. Falls back to first session if pane not found.

**`csm setup` details**: Installs a `SessionStart` hook into `~/.claude/settings.json` that writes pane→session ID mappings to `~/.config/csm/hook-events`. Creates `~/.config/csm/hooks/session-start.sh`. Safe to run multiple times (idempotent). Preserves existing hooks and settings.

## Architecture

```
src/
├── index.ts              # App entry: screen, keybindings, 3s refresh loop, state management, prefix sync
├── cli.ts                # CLI subcommands: next, reset, list, switch, setup (no blessed dependency)
├── types.ts              # All shared types (Session, RepoGroup, DisplayRow discriminated union, etc.)
├── monitor.ts            # Lightweight poller for tmux status-right (⚡3 🔄2), prefix sync, debug logging
├── core/
│   ├── sessions.ts       # Session discovery: index scan + pane/process correlation + archive detection + worktree grouping
│   ├── tmux.ts           # tmux wrappers: list-panes, capture-pane, switch, kill, rename, bell
│   ├── process.ts        # Find claude processes via ps, PID→TTY mapping
│   ├── status.ts         # Status detection from pane capture (spinner/prompt patterns), context %, time formatting
│   ├── config.ts         # ~/.config/csm/config.json — notification settings + repoPaths
│   ├── state.ts          # ~/.config/csm/state.json — shared TUI↔monitor attention state
│   ├── names.ts          # AI naming (claude -p), heuristic fallback, name cache
│   ├── git.ts            # Git operations: repo discovery, branch listing, checkout, worktree creation, base repo/default-branch resolution
│   ├── launch-command.ts # Pure builder for the new-session shell command (worktree/checkout + claude), shellQuote, worktreeDirName
│   ├── resurrect.ts      # Which cwd save-sessions records and which directory restore-sessions resumes in
│   └── notifications.ts  # Transition detection, prefix management (⚡/🔄), dispatch
└── ui/
    ├── layout.ts          # blessed screen + 3-region layout (list 70%, preview 30%, status bar)
    ├── session-list.ts    # Build display rows, ticket ID extraction, render with blessed tags, navigation
    ├── preview-pane.ts    # ANSI→blessed conversion, chrome stripping, bottom-aligned preview
    ├── wizard.ts          # New Session wizard: inline step-through UI (repo → branch → worktree → launch)
    ├── space-menu.ts      # Space action menu: which-key style popup (approve, send, copy, rename, kill, fork)
    ├── status-bar.ts      # Key hint bar (contextual: "switch" vs "resume")
    └── colors.ts          # Vesper palette constants + color helpers
```

### Data flow

`discoverSessions()` → scan index files + `listPanes()` + `findClaudeProcesses()` in parallel → correlate by TTY → `capturePane()` for status detection → `getBaseRepoPath()` for worktree resolution → `groupSessions()` → `buildDisplayRows()` → `renderSessionList()`

Two-phase discovery: Phase A = active tmux panes (fast), Phase B = archived from index files (last 24h, no active pane). Session UUIDs resolved via Claude Code's `SessionStart` hook (writes paneId→sessionId to `~/.config/csm/hook-events`). Run `csm setup` to install the hook.

### Worktree-aware repo grouping

Sessions in git worktrees group under their base repo via `getBaseRepoPath()` (uses `git rev-parse --git-common-dir`, cached). `baseRepoPath` on `Session` type drives repo naming, group paths, and wizard preselection. Worktrees sort after non-worktrees within the same status tier. Orphaned worktree directories (deleted) are resolved by scanning sibling dirs for git repos whose name is a prefix.

### Multi-pane window support

Windows with multiple Claude panes are named `{repo}` (same repo) or `{repo1}+{repo2}` (mixed). Attention prefix (⚡) only cleared from a window when no other panes in that window still need attention. State synced with external changes from `csm next` and the monitor on each refresh cycle.

### Session matching

Claude process TTYs (from `ps`) matched against tmux pane TTYs. `ps` reports `ttys001`, tmux reports `/dev/ttys001` — normalized by stripping `/dev/` prefix. `paneSessionCache` persists paneId→sessionId across refreshes.

### Switch mechanism

Active: writes `sessionName:windowIndex:paneId` to `/tmp/csm-switch`, exits. Wrapper script does `tmux select-window`/`select-pane`.
Archived: resumes via `claude -r {id}` (or `--fork` with `f` key) in new tmux window.

## Features

### Keybindings

| Key | Action |
|-----|--------|
| `j`/`k` | Move up/down (skips headers) |
| `J`/`K` | Jump to next/prev repo group |
| `Enter` | Switch (active) or resume (archived) |
| `Space` | Open action menu (approve, send, copy, rename, kill, fork) |
| `n` | New session wizard (repo → branch → worktree → launch) |
| `f` | Fork session (`--fork` in new window) |
| `x` | Kill pane (double-tap to confirm) |
| `u`/`d` | Scroll preview pane ±6 lines |
| `a` | Toggle archived sessions visibility |
| `q`/`Esc` | Quit |

### Space action menu (`Space` key)

Neovim which-key style popup at bottom-left. Press a key to select an action:

| Key | Action |
|-----|--------|
| `y` | Approve — context-aware sub-menu (tool approval or question answer) |
| `m` | Send message — type text to send to the session's pane |
| `c` | Copy preview pane text to clipboard (pbcopy) |
| `r` | Rename — generate AI name (claude -p, cached) |
| `x` | Kill pane (double-tap to confirm) |
| `f` | Fork session (`--fork` in new window) |

**Approve sub-menu** detects the session's state:
- **Tool approval** (Edit/Bash/etc.): `y` yes, `a` yes don't ask again, `n` no
- **AskUserQuestion**: Shows numbered options from JSONL, `t` to type custom answer

**Chat about this** (phone only): declines an open AskUserQuestion instead of picking an option, so the agent yields the turn and waits for a typed message. Held → the hook denies the tool via the decision file. Un-held (question fired at the desk, or the hold released/expired) → drives the native picker's own "Chat about this" row with one digit, pre-flighted from a fresh capture (`clarifyQuestion` in `core/tmux.ts` refuses when the picker isn't on screen, a permission prompt is up, or the free-text row has focus; unparseable chat row falls back to Escape). The question hold itself lasts up to 4h (`QUESTION_HOLD_MS`, its own matcher-scoped hook registration — approvals keep the 600s window) and releases early the moment the user is back at the Mac, so the native picker renders in front of them. Why hold-plus-release instead of pure send-keys: [ADR 8](docs/adr/0008-question-hold-not-send-keys.md).

**Send message**: Opens inline text input. Enter sends text + newline to the pane. Useful for approving tool calls or sending instructions without switching.

### Session statuses

| Status | Dot | Detection |
|--------|-----|-----------|
| waiting | ⏸ | Confirmation prompts, y/n, tool approval |
| running | ⦿ | Spinner chars (braille, unicode dots) |
| ready | ● | ❯ prompt visible |
| idle | ○ | No claude process on pane |
| archived | ○ | Modified in last 24h, no active pane |

Sort order: waiting → running → ready → idle → archived. Within same status: non-worktrees before worktrees; archived sorted most recent first. Priority repos pinned at top.

### Session labels

Session rows display "TICKET · name" labels extracted from branch names (Linear/Jira pattern like `ENG-2687`). Falls back to: ticket+branch-suffix → name alone → branch. Context % column removed from main row; summary detail rows no longer show `[name]` tag.

### Attention & notifications

4-tier system on status transitions (running→waiting = "blocked", running→ready = "turnComplete"):
1. Status monitor update (tmux status-right)
2. Window prefix: ⚡ added to tmux window name
3. macOS native notification (terminal-notifier/osascript; sound-only while Ghostty is frontmost)
4. Web Push to the portkey device that drove the turn (see below)

Window prefix priority: ⚡ (needs attention) > 🔄 (running) > ⏳ (waiting on background script) > none. Monitor syncs prefixes on each cycle. `stripAllPrefixes()` and `desiredPrefix()` in `notifications.ts` centralize prefix logic.

Auto-clears when user focuses the attention pane. Config in `~/.config/csm/config.json`.

**Tier 4 — per-device Web Push** (`core/web-push.ts`, no dependency — VAPID + RFC 8291 aes128gcm on Bun WebCrypto, pinned by the RFC's own test vector). Each portkey client mints a `deviceId` (localStorage), sends it as `x-csm-device` on every request (`?device=` on SSE), and registers a push subscription via `sw.js` — installed-PWA only; the navbar bell appears once (permission grant needs a gesture on iOS), after which a lost/pruned subscription silently resubscribes on launch. The source marker (`source/<id>.json`) records which device drove the turn; the monitor pushes only to that device, and only when its SSE liveness marker (`consumers/<deviceId>`, touched on connect/heartbeat, unlinked by the `sendBeacon` goodbye on backgrounding — the client closes its EventSource first so the heartbeat can't re-touch) is stale. Focusing the session's pane at the Mac clears the marker entirely (takeover). Pushes carry only the non-sensitive label + tool category; `tag = sessionId` keeps one notification per session (latest state wins); taps deep-link into the PWA (`notificationclick` → focus + `open-session` message, or `openWindow`). Prune on 401/403/404/410. Decision record: [ADR 6](docs/adr/0006-web-push-replaces-ntfy.md).

### Monitor (`bun run status`)

Lightweight poller for `tmux status-right` and sole authority for window naming. Quick-discovers active panes only (~50ms). Output: `⚡3 🔄2`. Shares state via `~/.config/csm/state.json`. Syncs ⚡/🔄 prefixes and AI names on window names. Opt-in debug logging to `~/.config/csm/debug.log` (auto-truncating, enabled by file existence).

### Preview pane

- Active: live ANSI capture with SGR→blessed tag conversion, chrome stripping (prompt/status line removed), bottom-aligned
- Archived: last assistant message from JSONL tail-read
- Collapsed archive: summary table of hidden sessions

### New Session wizard (`n` key)

Inline step-through UI that replaces the session list (no modal). Steps: repo → branch → worktree? → launch.

- **Repo step**: always-visible filter bar — type to search, arrows navigate (plain `j`/`k` type into the filter; `^J`/`^K` also move but aren't advertised). Repos discovered from active sessions + `repoPaths` config dirs. Worktrees are **collapsed by default** (base rows show a `▸/▾ N` chevron+count). Two ways to see a repo's worktrees: (1) **browse** — `→`/`Tab` on a base expands its worktrees nested inline (`←`/`Tab` collapses; `←` on a worktree collapses its parent); (2) **filter** — typing a query reveals matching worktrees flat, where a worktree matches by its branch **or** its base repo name (so typing the repo name surfaces its worktrees). Empty filter → base repos only. Enter on a base advances to the branch step; Enter on a worktree launches Claude there directly (`mode:"current"`). Preview pane shows a base-repo info panel (recent commits, worktree count, active-session indicator, path). Single repo auto-skips. Preselects the base repo of the home-screen selection. Expand keys (`→`/`←`) only apply in the browse view; while filtering they move the text cursor. Ctrl nav quirk: `^J` arrives as blessed keyName `linefeed` (not `C-j`); `^K` is `C-k`
- **Branch step**: arrows navigate (`^J`/`^K` also work), type activates type-to-filter (Esc clears). Preview pane shows `git log` for highlighted branch
- **Worktree-choice step**: Only shown when selected branch != current. Three options (fixed order): "New worktree + new branch" (fork off the selected branch), "New worktree on this branch" (reuse the branch as-is — no fork, so an agent's feature branch stays one branch/one PR), "Checkout in place" (last). Default cursor is context-aware: trunk (`origin/HEAD`, or main/master) → new-branch; feature branch → reuse. Reuse pre-checks `branchCheckedOutPath` and flashes a conflict (staying in the wizard) if the branch is already checked out elsewhere.
- **Worktree name step**: For new-branch, the field edits the new branch name; for reuse, it edits the worktree **directory** name (pre-filled with the branch name minus any `prefix/`, e.g. `cursor/ev-4-x` → `ev-4-x`). The dir is always `../{repo}-{name}` (the `{repo}-` prefix is required by worktree grouping).
- **Launch**: The git setup + `claude` run as one shell command inside the spawned tmux window (built by `buildLaunchCommand` in `core/launch-command.ts`), then exits the TUI. `^O` instead of Enter launches without Claude (git setup + plain shell — for using the wizard as a worktree creator); it works at every point where Enter would launch (worktree name step, existing-worktree row, current branch, checkout in place) and is hinted in the status bar only there

Refresh loop paused during wizard. Esc pops back one step (or cancels from the repo step). Git errors flash as status messages and keep wizard open for retry. Progress messages shown during checkout/worktree operations.

Config `repoPaths` (default `["~/Documents"]`): directories scanned 1-level deep for git repos to include alongside session repos.

### AI naming (`names.ts`)

Priority: cache → summary → plan title → first prompt + branch context. AI via `claude -p` subprocess with compact prompt (1-3 words, abbreviations encouraged). Names appear on tmux windows as `{repo}·{ai-name}`. Cache at `~/.config/csm/names.json` (v3).

### Window naming format

Tmux windows use the format `[⚡|🔄|⏳]{repo}[/{ai-name}][+]`:
- `{repo}` = base repo name from pane cwd (worktrees resolved via `getBaseRepoPath`)
- `/{ai-name}` = AI-generated compact name (1-3 words, kebab-case)
- `+` = fork indicator (transitional, until fork gets its own AI name)
- `⚡`/`🔄`/`⏳` = status prefixes (attention > running > script-wait > none)

`⏳` = the turn is over (status `ready`) but the session still waits on a live `run_in_background` script (same detection as portkey's list badge: transcript pending-scripts + `lsof` runner-liveness probe). Visibility only — it never feeds notifications, attention, `csm next`, sort order, or the status-right counts. The monitor computes it per tick via `core/script-wait.ts`, which persists the transcript parse + liveness verdicts to `~/.config/csm/script-wait.json` (the monitor is a fresh process per tick, so the in-process caches in `background-tasks.ts` don't survive). The TUI shows the same ⏳ inline before the row label, computed via `pendingScriptsAt` directly (long-lived process, in-process caches work).

Examples: `csm`, `csm/fix-auth`, `⚡csm/fix-auth`, `🔄api`, `csm/fix-auth+`
Multi-pane same repo: `{repo}`. Multi-pane mixed: `{repo1}+{repo2}`.
Helpers in `notifications.ts`: `buildBaseName()`, `extractAIName()`, `extractRepoFromWindowName()`.

### Portkey model/effort switcher

`/model` or `/effort` in the phone composer opens a selection sheet; tapping an option `POST`s to `/sessions/:id/config`, which sends the arg-form slash command via the existing send path and toasts Claude's confirmation. Validated against `MODEL_ARGS`/`EFFORT_ARGS` (`session-api.ts`). Scoping, the statusline prerequisite and the smoke test: [ADR 4](docs/adr/0004-model-effort-switcher-scope.md).

### Portkey background work (scripts + subagents, one surface)

A session waiting on a `run_in_background` script (e.g. pr-triage's Codex wait loop) genuinely ends its turn — status correctly reads `ready` — so the phone showed no sign it was mid-work. Scripts and async agents are the same harness machinery (tasks + `<task-notification>`), so they share one surface. `core/background-tasks.ts` recovers pending scripts by pairing background launches against notification records; label = the tool call's `description`, falling back to the raw command. Detection rules (each validated against real transcript history): the tool_result must *confirm* task creation (a denied/failed launch never notifies; a sync Agent result is its report; a foreground command that merely prints launch-shaped text can't match), and notifications arrive via three carriers (`user` message, `queue-operation`, queued_command `attachment` — the latter two when the session is mid-turn). Prototype that validated the rules: branch `proto/bg-task-detection`. Visibility only, by decision: dead/infinite scripts make "pending" unreliable as a status or notification input.

- **Sessions list**: `⏳` inline before the row name (inside `.name`, so the sub line keeps the column's left edge), and script-waiting sessions count into the header's `🔄` chip — churning-without-needing-you is the same answer that chip gives (`pendingScripts` count on the list payload via `pendingScriptsAt`, computed for live-process sessions only — without a Claude process the notification can never arrive, so a dead session would badge forever). Transcript-pending is additionally verified against reality by a runner-liveness probe (`liveScripts`): the runner holds an open fd on its `tasks/<id>.output` file for its whole life, so `lsof` on that path definitively separates a live wait from an orphan — a session resumed under a new Claude process orphans its tasks (runner dead, notification never comes, transcript says "pending" forever). Dead verdicts are terminal and cached; alive re-probes on a 15s TTL, applied per read (never from the mtime-keyed cache — a runner can die while the file sits still). Flip side: an intentionally-infinite background daemon shows for as long as it truly runs.
- **Navbar pill**: mint per-kind counts while anything is live (`🤖 2`, `⏳ 1`, `🤖 2 ⏳ 1`), dim `🤖 total` when everything's finished — a status while live, an archive entry point after (the drill-in is the only place a phone user can read a finished agent's report, since tool_results are stripped from the thread). The 15s safety poll runs while any background work is live.
- **Sheet** (tap the pill): pending scripts first (mint dot, `script · age` sub, inert — no conversation behind a shell loop), then running agents, then agents finished **since your last typed prompt** (fresh reports), then older collapsed behind one "N earlier agents" toggle. Boundary: `lastPromptAt` on the transcript payload (`readLastPromptAt` in `core/last-turn.ts` — backward windowed scan for the newest *real* prompt per `isPromptRecord`) vs each agent's `finishedAt` (its immutable jsonl's mtime); unknown boundary errs toward fresh. Header is a state summary ("1 waiting on script · 2 running · 5 done"). Completed/killed scripts are deliberately absent (no artifact, no action).

Detail transcript payload carries `pendingScripts` (computed in the same cached full-read as the branch parse) + `lastPromptAt`; fixtures exercise the full grouping and `bun run shoot` captures the open sheet as `agents.png`.

### Portkey changed-files viewer

A changed-files strip at the end of the thread → full file list → per-file diff. Backed by `core/repo-files.ts` (`branchChanges`, `fileDiff`, `safeRepoPath`) via `GET /sessions/:id/changes` and `/sessions/:id/diff?path=`, both containment-guarded to the session's repo root.

- The strip carries totals, PR state and the baseline — **no file preview**. The list is ordered latest-modified, so the first N of a 144-file branch are an arbitrary sample that reads as a summary. It's styled as thread furniture (full-bleed, unfilled, hairline-ruled), because a filled rounded box on `--surface` is exactly an assistant bubble.
- Diffs are re-indented to 2 spaces per level for phone width (`narrowIndent` in `shared/diff-lines.js`): leading whitespace only, levels preserved, so a tab-indented repo stops spending 8 columns per level. Display transform — the patch and the file are untouched.

- **Baseline** is the merge-base with the default branch — committed *and* uncommitted work, plus untracked files as all-additions. Every surface labels it `branch vs base`. Why, and why not transcript attribution: [ADR 2](docs/adr/0002-changed-files-baseline.md).
- **Scope** is a glance, not code review — no file browsing, line numbers, or approval-time diffs, by decision: [ADR 1](docs/adr/0001-changed-files-is-a-glance-surface.md).
- Patch rendering lives in `shared/diff-lines.js` (served unbuilt as `/diff-lines.js`, tested in `bun test`). It is hunk-aware on purpose — matching git's header patterns against every line eats real content, e.g. a deleted `-- ` line.
- Every git pathspec goes through `literal()` — a filename can contain glob metacharacters (`app/[slug]/page.tsx`).
- `/changes` has a 1s TTL cache; `/diff` reuses it to resolve a rename's old path, so a tool chip and a file-list row agree.
- The file list's top row links out to the branch's GitHub PR (`core/pull-request.ts` → `GET /sessions/:id/pr`, 60s TTL since it shells out to `gh`). Depth lives in the PR, not here; a merged PR is a "this session is done" signal. Why this instead of an in-app reviewer, and the variants rejected: [ADR 5](docs/adr/0005-link-out-to-the-pull-request.md).

### Portkey fork session

The long-press session sheet (alongside Archive) offers **Fork session** — same mechanics as the TUI `f`: `POST /sessions/:id/fork` → `forkSession` (`core/session-api.ts`) mints a fork id, launches `claude --session-id <forkId> --resume=<parent> --fork-session` in a new unfocused window (`launchForkWindow`, `-a -d`), blocks until the prompt is live, then returns the fork id. The sheet uses a two-tap confirm (non-destructive → mint fill, not red); the client shows the new-session `launching …` hint and opens straight into the fork.

- **Fork transcript seeding** (`seedForkTranscript`): Claude writes a fork's JSONL *lazily* — nothing lands on disk until the fork's first turn. On the phone that meant (a) an empty conversation and (b) the fork missing from Home (discovery blanks a live pane's id when no JSONL backs it — `buildActiveSession`). So after boot (before any turn — Claude hasn't created the file yet), `forkSession` copies the parent's transcript to the fork's path (`projects/<encode(effectivePath)>/<forkId>.jsonl`). Claude then treats it as the session history and *appends* the first turn (verified: no duplication) — so the fork is readable and discoverable immediately, and diverges cleanly on first message. Best-effort; a failed seed degrades to empty-until-first-turn.

## Conventions

- **Runtime**: Bun only — `Bun.$` for shell, `Bun.file()` for IO, `Bun.Glob` for scanning
- **UI**: blessed with `tags: true` for inline color (`{#FFC799-fg}text{/#FFC799-fg}`)
- **Types**: all in `src/types.ts`. `DisplayRow` = `"repo-header" | "separator" | "session" | "session-detail" | "archive-collapsed"`
- **Error handling**: all shell/IO in try/catch returning empty defaults. Never crash the TUI
- **No external deps** beyond `blessed`

## Vesper Color Palette

```
bg=#101010  fg=#FFFFFF  muted=#A0A0A0  dim=#505050
surface=#1C1C1C  peach=#FFC799  mint=#99FFE4  red=#FF8080
```

Status: waiting/ready=peach, running=mint, idle=dim. Context %: <50=mint, 50-79=peach, 80+=red.

## Safety

TUI refuses to run without a TTY (`process.stdout.isTTY` check). Rationale: [ADR 3](docs/adr/0003-tui-requires-a-tty.md).

## Session persistence (optional tmux-resurrect integration)

CSM can save and restore Claude Code sessions across tmux server crashes when paired with tmux-resurrect (and optionally tmux-continuum for auto-save).

### How it works

1. **On save** (`csm save-sessions`): Snapshots a mapping of stable tmux coordinates (`session:window.pane_index`) to Claude session UUIDs **and each session's cwd**, written to `~/.config/csm/resurrect-sessions.json`. This uses data already tracked by CSM's SessionStart hook in `pane-sessions.json`. A pane reporting `$HOME` never overwrites a real repo path already recorded for that session (`pickSavedCwd` in `core/resurrect.ts`) — a restored pane that hasn't got its directory back yet would otherwise poison the entry permanently.

2. **On restore** (`csm restore-sessions`): After tmux-resurrect restores panes (as empty shells), reads the saved mapping, matches coordinates to the newly created panes, and sends `cd <dir>; claude --resume=<sessionId>` in each via `tmux send-keys`. Skips panes that already have a foreground process, and skips a coordinate whose session id was already resumed this pass (one id can sit at two coordinates; resuming it twice leaves two processes fighting over one transcript).

   `<dir>` comes from `resolveRestoreTarget` (`core/resurrect.ts`), which tests `$HOME` **first** — `$HOME` is always a live directory, so a generic exists-check would shadow the case this exists to repair. Order: saved cwd is `$HOME` → Claude's last-recorded cwd from the transcript; saved cwd still on disk → itself; saved cwd gone (deleted worktree) → its base repo, via `recoverWorktreeTranscript` so the resumed session isn't tailing a frozen transcript copy; otherwise no `cd` at all. The separator is `;`, not `&&`, so a failed `cd` still leaves the session resumed.

### Setup

Add these hooks to your `tmux.conf` alongside the tmux-resurrect plugin config:

```
set -g @resurrect-hook-post-save-all 'csm save-sessions'
set -g @resurrect-hook-post-restore-all 'csm restore-sessions'
```

If using tmux-continuum for auto-save, the save hook runs automatically on each periodic save. The restore hook runs when `@continuum-restore 'on'` triggers a restore on server start.

### Commands

| Command | Description | When called |
|---------|-------------|-------------|
| `csm save-sessions` | Snapshot pane→session map using stable tmux coordinates | tmux-resurrect post-save hook or manually |
| `csm restore-sessions` | Launch `claude --resume` in restored panes | tmux-resurrect post-restore hook or manually |

### Data flow

Save: `pane-sessions.json` (paneId→sessionId) + `tmux list-panes` (paneId→coordinate+cwd) + the previous map (for `pickSavedCwd`) → `resurrect-sessions.json` (coordinate→{sessionId, cwd})

Restore: `resurrect-sessions.json` (coordinate→{sessionId, cwd}) + `tmux list-panes` (coordinate→new paneId) → `resolveRestoreTarget` (cwd→directory to resume in) → `tmux send-keys` (`cd <dir>; claude --resume` in each pane)

### Limitations

- Requires CSM's SessionStart hook to be installed (`csm setup`) so pane→session mappings are tracked.
- The mapping is only as fresh as the last save. Sessions started after the last save won't be in the map.
- Pane coordinates rely on tmux-resurrect restoring the same session/window/pane layout. Manual tmux reconfiguration after restore may shift coordinates.

## Key references

- `docs/adr/` — decision records: why something is the way it is, and what was rejected
- `ideas.txt` — feature backlog (worktrees, search, Cursor integration, etc.)
- Session data: `~/.claude/projects/*/sessions-index.json`
- Session logs: `~/.claude/projects/*/{sessionId}.jsonl`
- Config/state: `~/.config/csm/{config,state,names}.json`
- Hook events: `~/.config/csm/hook-events` (SessionStart hook writes pane→session mappings)
- Hook script: `~/.config/csm/hooks/session-start.sh` (installed by `csm setup`)
- Resurrect map: `~/.config/csm/resurrect-sessions.json` (coordinate→sessionId, written by save-sessions)
- Web Push state: `~/.config/csm/push-vapid.json` (VAPID keypair), `push-subscriptions.json` (deviceId→subscription), `consumers/<deviceId>` (per-device SSE liveness), `source/<sessionId>.json` (which device drove the turn)
- Script-wait cache: `~/.config/csm/script-wait.json` (per-session transcript parse + runner-liveness verdicts for the ⏳ prefix)
- Debug log: `~/.config/csm/debug.log` (monitor debug, create file to enable)
