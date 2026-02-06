# Claude Session Manager (`csm`) — MVP Plan

## What It Does

A full-screen terminal TUI launched via `tmux display-popup` (`prefix + a`). Shows all Claude Code sessions grouped by repo, with live status detection, and lets you switch to any session with `Enter`. A preview pane shows the selected session's live terminal output.

---

## Tech Stack

- **Runtime**: Bun
- **TUI**: blessed (pure JS, Bun-compatible — Ink has [yoga-layout Bun issues](https://github.com/oven-sh/bun/issues/2034))
- **Data**: Claude Code's `~/.claude/projects/*/sessions-index.json` (JSONL + JSON)
- **Process detection**: `ps` + tmux pane TTY cross-referencing
- **Git**: `git diff --stat` for lines modified

---

## Data Model

```ts
interface Session {
  id: string;
  repo: string;
  repoPath: string;
  branch: string;
  status: "input" | "running" | "idle";
  contextPercent: number;
  linesModified: number;
  messageCount: number;
  summary: string;
  modified: Date;
  tmuxPane?: { paneId: string; windowIndex: number; sessionName: string };
}

// Sessions grouped for display
interface RepoGroup {
  name: string;           // Short repo name
  path: string;           // Full path
  sessions: Session[];    // Sorted: input → running → idle
}
```

---

## Session Discovery (runs every 3s)

1. **Parse sessions from disk**: read all `~/.claude/projects/*/sessions-index.json`
2. **Find running claude processes**: `ps -eo pid,tty,command | grep '[c]laude'`
3. **Map to tmux panes**: `tmux list-panes -a -F '#{pane_tty} #{pane_id} #{session_name} #{window_index} #{pane_current_path}'`
4. **Detect status**: `tmux capture-pane -t {paneId} -p -S -5` then pattern-match:
   - `❯` or `>` at end → **input** (waiting for you)
   - Spinner / "Thinking" / tool output → **running**
   - No process found → **idle**
5. **Lines modified**: `git -C {path} diff --stat | tail -1`
6. **Context %**: estimate from messageCount × ~800 tokens / 200k window, or parse from captured pane status bar
7. **Group**: bucket sessions by repo name, sort each group by status priority, then by modified desc

---

## UI Design

### Color Palette (Vesper theme)

Designed to feel native in Ghostty + Vesper. Uses the theme's warm peach and cool
mint accents against the deep black background.

```
Background ─────── #101010  (terminal default, not forced)
Foreground ─────── #FFFFFF  (primary text)
Muted text ─────── #A0A0A0  (secondary info, timestamps)
Dim ────────────── #505050  (separators, borders, inactive)
Surface ────────── #1C1C1C  (selected row background)
Hover ──────────── #282828  (subtle highlight)

Peach accent ───── #FFC799  (selection cursor, repo headers, "input" status)
Mint accent ────── #99FFE4  (running status, low context %, lines modified)
Soft red ──────── #FF8080  (high context %, errors)
```

### Layout

```
                              ╭──── dim #505050 border, no title clutter
                              │
  ┌───────────────────────────────────────────────────────────────────┐
  │                                                                   │
  │   throxy                                              ← #FFC799 bold repo header
  │   ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈   ← #505050 thin separator
  │                                                                   │
  │   ▸ main                ● input    45%    +120    2m   ← selected: #1C1C1C bg, #FFC799 cursor
  │     feature/search      ◉ running  72%    +340    now  ← #99FFE4 status
  │     feat/dashboard      ○ idle     88%    +580    1h   ← #505050 dimmed entire row
  │                                                                   │
  │   mixrank                                              ← #FFC799 bold repo header
  │   ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈   ← #505050 thin separator
  │                                                                   │
  │     develop             ● input    12%     +45    5m              │
  │                                                                   │
  │                                                                   │
  │                                                                   │
  ├───────────────────────────────────────────────────────────────────┤
  │   throxy/main                                          ← #A0A0A0 preview header
  │                                                                   │
  │   I've updated the auth middleware to use JWT tokens.             │
  │   The changes include:                                            │
  │   - New `verifyToken` middleware in `src/auth.ts`                 │
  │                                                                   │
  │   ❯ _                                                             │
  │                                                                   │
  ├───────────────────────────────────────────────────────────────────┤
  │   j/k ↑↓    ⏎ switch    r resume    R refresh    q quit          │
  └───────────────────────────────────────────────────────────────────┘
       │              │
       #FFC799 keys   #A0A0A0 descriptions
```

### Row Styling Rules

**Selected row:**
- Background: `#1C1C1C`
- Cursor: `▸` in `#FFC799`
- Branch text: `#FFFFFF` bold
- All other columns: full brightness

**Unselected row:**
- No background (transparent to `#101010`)
- Cursor: two spaces indent (no marker)
- Branch text: `#A0A0A0`

**Idle row (unselected):**
- Entire row dimmed to `#505050`
- Makes active sessions visually pop

### Column Layout

```
  ▸ main                ● input    45%    +120    2m
  │ │                   │ │        │      │       │
  │ branch              │ status   ctx%   lines   time ago
  │ left-aligned        │ label    right  right   right
  │ 20ch max            │                         #A0A0A0
  cursor                status dot
  #FFC799               (see below)
```

### Status Rendering

| Status | Dot | Label | Color |
|--------|-----|-------|-------|
| input | `●` | `input` | `#FFC799` (peach) — warm, draws attention |
| running | `◉` | `running` | `#99FFE4` (mint) — cool, active |
| idle | `○` | `idle` | `#505050` (dim) — faded, not urgent |

### Context % Colors

| Range | Color | Meaning |
|-------|-------|---------|
| 0-49% | `#99FFE4` (mint) | Healthy |
| 50-79% | `#FFC799` (peach) | Getting warm |
| 80-100% | `#FF8080` (red) | Consider forking |

### Lines Modified

Always `#99FFE4` (mint), matching Vesper's git-added color. Prefixed with `+`.

### Time Ago

Relative time in `#A0A0A0` (muted). Short format: `now`, `2m`, `15m`, `1h`, `3h`, `1d`.

### Repo Headers

- Text: `#FFC799` bold
- Followed by a thin dotted line in `#505050` (`┈` characters)
- One blank line before each repo group (except the first)
- Repo headers are **not selectable** — j/k skips over them

### Preview Pane

- Separated by a horizontal line in `#505050`
- Header line: `repo/branch` in `#A0A0A0`, left-aligned
- Content: raw captured tmux output (preserving colors from the Claude session)
- For idle sessions: last assistant message from JSONL in `#A0A0A0` italic
- Updates every 3s alongside the refresh loop

### Status Bar

- Background: same as terminal (`#101010`)
- Keys: `#FFC799` (peach)
- Descriptions: `#505050` (dim)
- Separated by 4 spaces between each binding
- Format: `j/k ↑↓    ⏎ switch    r resume    R refresh    q quit`

### Empty State

When no sessions exist:

```
  ┌───────────────────────────────────────────────────┐
  │                                                   │
  │                                                   │
  │              No active sessions                   │  ← #A0A0A0
  │                                                   │
  │         Start one with: claude                    │  ← #505050
  │                                                   │
  │                                                   │
  └───────────────────────────────────────────────────┘
```

---

## Key Bindings (MVP)

| Key | Action |
|-----|--------|
| `j` / `↓` | Move selection down (skips repo headers) |
| `k` / `↑` | Move selection up (skips repo headers) |
| `Enter` | Switch to session's tmux pane |
| `r` | Resume idle session (`claude -r {id}`) in new tmux window |
| `R` | Force refresh |
| `q` / `Esc` | Quit |

---

## tmux Popup

Add to `~/.tmux.conf`:
```bash
bind-key a display-popup -E -w 90% -h 85% "csm"
```

On `Enter`, write target pane ID to `/tmp/csm-switch`, exit, and a wrapper script does `tmux select-window` + `tmux select-pane` after popup closes.

---

## Project Structure

```
claude-session-manager/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry: init blessed screen, start app
│   ├── ui/
│   │   ├── layout.ts         # Screen + box layout (3 regions)
│   │   ├── session-list.ts   # Grouped list: repo headers + session rows
│   │   ├── preview-pane.ts   # Preview widget
│   │   ├── status-bar.ts     # Bottom key hints
│   │   └── colors.ts         # Vesper palette constants
│   ├── core/
│   │   ├── sessions.ts       # Parse ~/.claude/ session data
│   │   ├── tmux.ts           # Tmux commands (list-panes, capture-pane, select)
│   │   ├── process.ts        # PID → TTY → pane mapping
│   │   └── status.ts         # Status detection from pane capture
│   └── types.ts              # Type definitions
└── bin/
    └── csm.ts                # #!/usr/bin/env bun
```

---

## MVP Scope Checklist

- [x] Blessed screen with 3-region layout (list, preview, status bar)
- [x] `colors.ts` with full Vesper palette constants
- [x] Session discovery from `~/.claude/projects/*/sessions-index.json`
- [x] Process → TTY → tmux pane cross-referencing
- [x] Status detection (input / running / idle)
- [x] Grouped session list: repo headers in peach, sessions underneath
- [x] Row styling: selected highlight, idle dimming, status-colored dots
- [x] Columns: branch, status, context %, lines modified, time ago
- [x] Sorted within groups: input → running → idle, then modified desc
- [x] j/k navigation that skips repo headers
- [x] Enter → switch to tmux pane (via /tmp/csm-switch + wrapper)
- [x] r → resume idle session in new tmux window
- [x] Live preview pane with captured tmux content
- [x] Auto-refresh loop (3s)
- [ ] `prefix + a` tmux popup binding
- [x] Empty state for no sessions
