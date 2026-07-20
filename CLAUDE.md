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

Two-phase discovery: Phase A = active tmux panes (fast), Phase B = archived from index files (>3h old, no active pane). Session UUIDs resolved via Claude Code's `SessionStart` hook (writes paneId→sessionId to `~/.config/csm/hook-events`). Run `csm setup` to install the hook.

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

**Send message**: Opens inline text input. Enter sends text + newline to the pane. Useful for approving tool calls or sending instructions without switching.

### Session statuses

| Status | Dot | Detection |
|--------|-----|-----------|
| waiting | ⏸ | Confirmation prompts, y/n, tool approval |
| running | ⦿ | Spinner chars (braille, unicode dots) |
| ready | ● | ❯ prompt visible |
| idle | ○ | No claude process on pane |
| archived | ○ | >3h old, no active pane |

Sort order: waiting → running → ready → idle → archived. Within same status: non-worktrees before worktrees. Priority repos pinned at top.

### Session labels

Session rows display "TICKET · name" labels extracted from branch names (Linear/Jira pattern like `ENG-2687`). Falls back to: ticket+branch-suffix → name alone → branch. Context % column removed from main row; summary detail rows no longer show `[name]` tag.

### Attention & notifications

2-tier system on status transitions (running→waiting = "blocked", running→ready = "turnComplete"):
1. Status monitor update (tmux status-right)
2. Window prefix: ⚡ added to tmux window name

Window prefix priority: ⚡ (needs attention) > 🔄 (running) > none. Monitor syncs prefixes on each cycle. `stripAllPrefixes()` and `desiredPrefix()` in `notifications.ts` centralize prefix logic.

Auto-clears when user focuses the attention pane. Config in `~/.config/csm/config.json`.

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
- **Launch**: The git setup + `claude` run as one shell command inside the spawned tmux window (built by `buildLaunchCommand` in `core/launch-command.ts`), then exits the TUI

Refresh loop paused during wizard. Esc pops back one step (or cancels from the repo step). Git errors flash as status messages and keep wizard open for retry. Progress messages shown during checkout/worktree operations.

Config `repoPaths` (default `["~/Documents"]`): directories scanned 1-level deep for git repos to include alongside session repos.

### AI naming (`names.ts`)

Priority: cache → summary → plan title → first prompt + branch context. AI via `claude -p` subprocess with compact prompt (1-3 words, abbreviations encouraged). Names appear on tmux windows as `{repo}·{ai-name}`. Cache at `~/.config/csm/names.json` (v3).

### Window naming format

Tmux windows use the format `[⚡|🔄]{repo}[/{ai-name}][+]`:
- `{repo}` = base repo name from pane cwd (worktrees resolved via `getBaseRepoPath`)
- `/{ai-name}` = AI-generated compact name (1-3 words, kebab-case)
- `+` = fork indicator (transitional, until fork gets its own AI name)
- `⚡`/`🔄` = status prefixes (attention > running > none)

Examples: `csm`, `csm/fix-auth`, `⚡csm/fix-auth`, `🔄api`, `csm/fix-auth+`
Multi-pane same repo: `{repo}`. Multi-pane mixed: `{repo1}+{repo2}`.
Helpers in `notifications.ts`: `buildBaseName()`, `extractAIName()`, `extractRepoFromWindowName()`.

### Portkey model/effort switcher

The phone can change a session's model or reasoning effort. Typing `/model` or `/effort` in the composer opens a native selection sheet (current value marked); tapping an option `POST`s to `/sessions/:id/config`, which sends the arg-form slash command (`/model opus`, `/effort ultracode`) via the existing send path and toasts Claude's verbatim confirmation. Scope is Claude's: model + normal effort set the **global default** ("for new sessions"); `ultracode` is **session-only**. Route validates against `MODEL_ARGS`/`EFFORT_ARGS` (`session-api.ts`) — nothing reaches the pane on a bad value. Mechanics guarded by `test/smoke/model-effort.sh` (opt-in, drives real sessions — not in `bun test`).

**Prerequisite (one-time, user dotfile):** current *effort* is read by scraping the pane statusline, so `~/.claude/statusline.sh` must render `.effort.level` as its trailing `• <level>` segment (it replaced the old `• thinking` boolean). Current *model* needs no change — it's already in the statusline. Without the statusline edit the model switcher still works; the effort menu just can't pre-mark the current level.

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

TUI refuses to run without a TTY (`process.stdout.isTTY` check) to prevent orphaned background processes (e.g. from `bun --watch` after terminal closes) from overwriting `state.json` with stale attention flags.

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

- `ideas.txt` — feature backlog (worktrees, search, Cursor integration, etc.)
- Session data: `~/.claude/projects/*/sessions-index.json`
- Session logs: `~/.claude/projects/*/{sessionId}.jsonl`
- Config/state: `~/.config/csm/{config,state,names}.json`
- Hook events: `~/.config/csm/hook-events` (SessionStart hook writes pane→session mappings)
- Hook script: `~/.config/csm/hooks/session-start.sh` (installed by `csm setup`)
- Resurrect map: `~/.config/csm/resurrect-sessions.json` (coordinate→sessionId, written by save-sessions)
- Debug log: `~/.config/csm/debug.log` (monitor debug, create file to enable)
