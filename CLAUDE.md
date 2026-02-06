# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# CSM — Claude Session Manager

Full-screen terminal TUI (blessed) for managing Claude Code sessions. Launched via `tmux display-popup`. Shows sessions grouped by repo with live status detection, preview pane, and vim navigation.

## Commands

```sh
bun run src/index.ts      # Run directly
bun run start             # Same as above
bun run dev               # Watch mode (--watch)
bun test                  # Run tests (bun:test)
```

Entry: `bin/csm.ts` → `src/index.ts`

## Architecture

```
src/
├── index.ts              # App entry: screen init, key bindings, refresh loop (3s)
├── types.ts              # All shared types (Session, RepoGroup, DisplayRow, etc.)
├── core/
│   ├── sessions.ts       # Session discovery: scan ~/.claude/projects/*/sessions-index.json
│   ├── tmux.ts           # tmux commands: list-panes, capture-pane, write switch target
│   ├── process.ts        # Find claude processes via ps, map PID→TTY
│   └── status.ts         # Detect status from pane capture, context % estimation, time formatting
└── ui/
    ├── layout.ts          # blessed screen + 3-region layout (list 70%, preview 30%, status bar)
    ├── session-list.ts    # Build display rows, render with blessed tags, j/k navigation
    ├── preview-pane.ts    # Live tmux capture for active, last assistant message for idle
    ├── status-bar.ts      # Key hint bar at bottom
    └── colors.ts          # Vesper palette constants + color helpers
```

### Data flow

`discoverSessions()` → scan index files + `listPanes()` + `findClaudeProcesses()` in parallel → correlate by TTY → `capturePane()` for status detection → `groupSessions()` → `buildDisplayRows()` → `renderSessionList()`

### Session matching

Claude process TTYs (from `ps`) are matched against tmux pane TTYs. `ps` reports `ttys001`, tmux reports `/dev/ttys001` — normalized by stripping `/dev/` prefix.

### Switch mechanism

On Enter: writes `sessionName:windowIndex:paneId` to `/tmp/csm-switch`, then exits. A wrapper script reads this file and runs `tmux select-window`/`select-pane`.

## Conventions

- **Runtime**: Bun only — use `Bun.$` for shell commands, `Bun.file()` for file I/O, `Bun.Glob` for file scanning
- **UI framework**: blessed with `tags: true` for inline color markup (`{#FFC799-fg}text{/#FFC799-fg}`)
- **Types**: all in `src/types.ts`, imported where needed. `DisplayRow` is a discriminated union (`type: "repo-header" | "separator" | "session"`)
- **Error handling**: all shell/IO ops wrapped in try/catch returning empty defaults (empty array, empty string, 0). Never crash the TUI
- **No external deps** beyond `blessed` — all tmux/git/process detection via shell commands

## Vesper Color Palette

```
C.bg      #101010   terminal default (not forced)
C.fg      #FFFFFF   primary text
C.muted   #A0A0A0   secondary text, timestamps
C.dim     #505050   borders, separators, idle rows
C.surface #1C1C1C   selected row background
C.peach   #FFC799   selection cursor, repo headers, input status, key hints
C.mint    #99FFE4   running status, healthy context %, lines modified
C.red     #FF8080   high context %
```

Status colors: input=peach, running=mint, idle=dim. Context %: <50=mint, 50-79=peach, 80+=red.

## Key references

- `PLAN.md` — full MVP spec with UI mockups, column layout, row styling rules
- `ideas.txt` — backlog of post-MVP features (worktrees, AI naming, notifications, etc.)
- Session data: `~/.claude/projects/*/sessions-index.json` (JSON with `entries[]` of `SessionIndexEntry`)
- Session logs: `~/.claude/projects/*/{sessionId}.jsonl` (JSONL with `type: "assistant"` messages)
