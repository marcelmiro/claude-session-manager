# CLAUDE.md

# CSM — Claude Session Manager

Full-screen terminal TUI (blessed) for managing Claude Code sessions. Launched via `tmux display-popup`. Shows sessions grouped by repo with live status detection, ANSI preview pane, vim navigation, attention notifications, and AI naming.

## Environment

macOS (ARM) with Ghostty terminal, Oh My Zsh, and tmux.

## Commands

```sh
bun run start             # Run TUI
bun run dev               # Watch mode (--watch)
bun run status            # Lightweight tmux status-right widget
bun test                  # Run tests (bun:test)
```

Entry: `bin/csm.ts` (CLI router) → `src/index.ts` (TUI) or `src/cli.ts` (subcommands)

## CLI subcommands

`bin/csm.ts` routes based on `process.argv[2]`. All subcommands except `status` live in `src/cli.ts`.

| Command | Description | Output |
|---------|-------------|--------|
| `csm` | Open full TUI | blessed screen |
| `csm next` | Switch to next attention session (oldest first) | tmux display-message |
| `csm reset` | Reset all window names to "claude", clear ⚡ and attention state | tmux display-message |
| `csm status` | Tmux status-right widget (`⚡3 🔄2`) | stdout |
| `csm list` | Text-only session list with status/repo/context% | stdout |
| `csm switch <name>` | Fuzzy-match session by name and switch to it | tmux display-message |
| `csm --help` | Show available commands and usage | stdout |

**Testing subcommands**: Use `bun run bin/csm.ts <cmd>` to test without installing globally. Example: `bun run bin/csm.ts list` prints active sessions to stdout — useful for verifying session discovery, status detection, and name resolution without launching the TUI.

**`csm next` details**: Reads `state.json` attention flags, picks the session with the oldest `lastTransition` timestamp, clears its attention flag, strips ⚡ prefix, and calls `switchToPane()`. Falls back to scanning tmux windows for ⚡ prefixes when state.json has no valid candidates (handles state↔window desync).

**`csm reset` details**: Lists all tmux windows, renames any with non-standard names (not in `claude|zsh|bash|dev|fish|sh`) back to "claude". Strips both ⚡ and 🔄 prefixes. Also clears all attention flags in `state.json`.

**`csm switch` scoring**: exact=100, starts-with=80, contains=60, word-starts-with=40, subsequence=20. Matches against window names with ⚡/🔄 stripped.

## Architecture

```
src/
├── index.ts              # App entry: screen, keybindings, 3s refresh loop, state management, prefix sync
├── cli.ts                # CLI subcommands: next, reset, list, switch (no blessed dependency)
├── types.ts              # All shared types (Session, RepoGroup, DisplayRow discriminated union, etc.)
├── status-widget.ts      # Lightweight poller for tmux status-right (⚡3 🔄2), prefix sync, debug logging
├── core/
│   ├── sessions.ts       # Session discovery: index scan + pane/process correlation + archive detection + worktree grouping
│   ├── tmux.ts           # tmux wrappers: list-panes, capture-pane, switch, kill, rename, bell
│   ├── process.ts        # Find claude processes via ps, PID→TTY mapping, lsof→sessionId resolution
│   ├── status.ts         # Status detection from pane capture (spinner/prompt patterns), context %, time formatting
│   ├── config.ts         # ~/.config/csm/config.json — notification settings + repoPaths
│   ├── state.ts          # ~/.config/csm/state.json — shared TUI↔widget attention state
│   ├── names.ts          # AI naming (claude -p), heuristic fallback, name cache
│   ├── git.ts            # Git operations: repo discovery, branch listing, checkout, worktree creation, base repo resolution
│   └── notifications.ts  # Transition detection, prefix management (⚡/🔄), dispatch
└── ui/
    ├── layout.ts          # blessed screen + 3-region layout (list 70%, preview 30%, status bar)
    ├── session-list.ts    # Build display rows, ticket ID extraction, render with blessed tags, navigation
    ├── preview-pane.ts    # ANSI→blessed conversion, chrome stripping, bottom-aligned preview
    ├── wizard.ts          # New Session wizard: inline step-through UI (repo → branch → worktree → launch)
    ├── status-bar.ts      # Key hint bar (contextual: "switch" vs "resume")
    └── colors.ts          # Vesper palette constants + color helpers
```

### Data flow

`discoverSessions()` → scan index files + `listPanes()` + `findClaudeProcesses()` in parallel → correlate by TTY → `capturePane()` for status detection → `getBaseRepoPath()` for worktree resolution → `groupSessions()` → `buildDisplayRows()` → `renderSessionList()`

Two-phase discovery: Phase A = active tmux panes (fast), Phase B = archived from index files (>3h old, no active pane). lsof resolves session UUIDs but is skipped on first render for speed (~1-3s cold start), filled in on 3s refresh.

### Worktree-aware repo grouping

Sessions in git worktrees group under their base repo via `getBaseRepoPath()` (uses `git rev-parse --git-common-dir`, cached). `baseRepoPath` on `Session` type drives repo naming, group paths, and wizard preselection. Worktrees sort after non-worktrees within the same status tier. Orphaned worktree directories (deleted) are resolved by scanning sibling dirs for git repos whose name is a prefix.

### Multi-pane window support

Windows with multiple Claude panes are named `claude/{repo}` (same repo) or `claude` (mixed). Attention prefix (⚡) only cleared from a window when no other panes in that window still need attention. State synced with external changes from `csm next` and the status widget on each refresh cycle.

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
| `n` | New session wizard (repo → branch → worktree → launch) |
| `f` | Fork session (`--fork` in new window) |
| `x` | Kill pane (double-tap to confirm) |
| `s` | Generate AI name (claude -p, cached) |
| `c` | Open repo in Cursor IDE |
| `y` | Copy preview pane text to clipboard (pbcopy) |
| `r` | Force refresh |
| `u`/`d` | Scroll preview pane ±6 lines |
| `a` | Toggle archived sessions visibility |
| `q`/`Esc` | Quit |

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
1. Status widget update (tmux status-right)
2. Window prefix: ⚡ added to tmux window name

Window prefix priority: ⚡ (needs attention) > 🔄 (running) > none. Both TUI and status widget sync prefixes on each cycle. `stripAllPrefixes()` and `desiredPrefix()` in `notifications.ts` centralize prefix logic.

Auto-clears when user focuses the attention pane. Config in `~/.config/csm/config.json`.

### Status widget (`bun run status`)

Lightweight poller for `tmux status-right`. Reuses TUI state if <10s old, else quick-discovers active panes only (~50ms). Output: `⚡3 🔄2`. Shares state via `~/.config/csm/state.json`. Also syncs ⚡/🔄 prefixes on window names. Opt-in debug logging to `~/.config/csm/debug.log` (auto-truncating, enabled by file existence).

### Preview pane

- Active: live ANSI capture with SGR→blessed tag conversion, chrome stripping (prompt/status line removed), bottom-aligned
- Archived: last assistant message from JSONL tail-read
- Collapsed archive: summary table of hidden sessions

### New Session wizard (`n` key)

Inline step-through UI that replaces the session list (no modal). Steps: repo → branch → worktree? → launch.

- **Repo step**: j/k navigate repos discovered from active sessions + `repoPaths` config dirs. Single repo auto-skips
- **Branch step**: j/k navigate, `/` activates type-to-filter mode (Esc clears). Preview pane shows `git log` for highlighted branch
- **Worktree step**: Only shown when selected branch != current. Options: "No worktree" (checkout in-place) or "Create worktree at ../repo.branch"
- **Launch**: Opens `tmux new-window -c {dir} claude` in main session, exits TUI

Refresh loop paused during wizard. Esc pops back one step (or cancels from first step). `q` quits from repo step. Git errors flash as status messages and keep wizard open for retry. Progress messages shown during checkout/worktree operations.

Config `repoPaths` (default `["~/Documents"]`): directories scanned 1-level deep for git repos to include alongside session repos.

### AI naming (`names.ts`)

Priority: cache → summary → plan title → first prompt. AI via `claude -p` subprocess. Heuristic fallback: strip prefixes, filter stop words, kebab-case. Cache at `~/.config/csm/names.json`.

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

## Key references

- `ideas.txt` — feature backlog (worktrees, search, Cursor integration, etc.)
- Session data: `~/.claude/projects/*/sessions-index.json`
- Session logs: `~/.claude/projects/*/{sessionId}.jsonl`
- Config/state: `~/.config/csm/{config,state,names}.json`
- Debug log: `~/.config/csm/debug.log` (widget debug, create file to enable)
