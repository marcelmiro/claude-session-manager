/**
 * CSM CLI subcommands — lightweight commands that don't require the full TUI.
 *
 * csm next              — switch to the next session needing attention
 * csm reset             — reset all window names back to repo names
 * csm list              — print a text-only session list
 * csm switch <name>     — fuzzy-match a session by name and switch to it
 * csm save-sessions     — snapshot pane→session mappings for tmux-resurrect
 * csm restore-sessions  — restore Claude sessions after tmux-resurrect restore
 */

import { homedir } from "os";
import { loadState, saveState, loadPaneSessions } from "./core/state";
import { switchToPane, listPanes, renameWindow, capturePane, displayMessage } from "./core/tmux";
import { syncWindowPrefix, stripAllPrefixes, ATTENTION_PREFIX } from "./core/notifications";
import { findClaudeProcesses } from "./core/process";
import { detectStatus } from "./core/status";
import { eventSourcedStatus } from "./core/hook-events";
import { nativeStatus } from "./core/session-state";
import { loadNameCache } from "./core/names";
import { PATHS } from "./core/config";

const home = homedir();

// ---------------------------------------------------------------------------
// csm next
// ---------------------------------------------------------------------------

/**
 * Switch to the next session needing attention.
 * Picks the session that has been waiting the longest (oldest lastTransition).
 * Validates each candidate is still alive and genuinely needs attention before switching.
 */
export async function next(): Promise<void> {
  const state = await loadState();

  // Clear attention for the pane the user is currently viewing.
  // Without this, csm-next ping-pongs: switches away from pane A (still flagged)
  // to pane B, then next call picks A again because its flag was never cleared.
  let activePaneId: string | undefined;
  try {
    const client = (await Bun.$`tmux list-clients -F '#{client_name}'`.quiet().text()).trim().split("\n")[0];
    if (client) {
      activePaneId = (await Bun.$`tmux display-message -c ${client} -p '#{pane_id}'`.quiet().text()).trim();
      const activeSession = state.sessions[activePaneId];
      if (activePaneId && activeSession?.needsAttention) {
        activeSession.needsAttention = false;
        activeSession.attentionType = undefined;
        // Sync prefix on source window — may restore 🔄 if other panes are running
        if (activeSession.tmuxSession !== undefined && activeSession.tmuxWindow !== undefined) {
          const othersInSourceWindow = Object.values(state.sessions).filter(
            (s) =>
              s.tmuxPane !== activePaneId &&
              s.tmuxSession === activeSession.tmuxSession &&
              String(s.tmuxWindow) === String(activeSession.tmuxWindow),
          );
          const hasAttention = othersInSourceWindow.some(s => s.needsAttention);
          const hasRunning = activeSession.status === "running" ||
            othersInSourceWindow.some(s => s.status === "running");
          await syncWindowPrefix(activeSession.tmuxSession!, activeSession.tmuxWindow!, hasAttention, hasRunning);
        }
      }
    }
  } catch {
    // Not in tmux context
  }

  const attentionSessions = Object.entries(state.sessions)
    .filter(([_, s]) => s.needsAttention)
    .sort(
      (a, b) => (a[1].lastTransition ?? Infinity) - (b[1].lastTransition ?? Infinity),
    );

  // Validate candidates from state: check pane still exists and session still needs attention
  let target: { paneId: string; tmuxSession: string; tmuxWindow: number } | null = null;
  for (const candidate of attentionSessions) {
    const [_, s] = candidate;
    if (!s.tmuxSession || s.tmuxWindow === undefined || !s.tmuxPane) continue;

    // Capture pane to verify it exists and check current status
    const captured = await capturePane(s.tmuxPane);
    if (!captured) {
      // Pane is dead — clear stale attention
      s.needsAttention = false;
      s.attentionType = undefined;
      continue;
    }

    const plain = captured
      .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const result = detectStatus(plain, true);

    if (result.status === "running" || result.status === "idle") {
      // Session no longer needs attention — clear stale flag, sync prefix
      s.needsAttention = false;
      s.attentionType = undefined;
      if (s.tmuxSession !== undefined && s.tmuxWindow !== undefined) {
        const others = Object.values(state.sessions).filter(
          (o) => o.tmuxPane !== s.tmuxPane &&
            o.tmuxSession === s.tmuxSession && String(o.tmuxWindow) === String(s.tmuxWindow),
        );
        await syncWindowPrefix(s.tmuxSession!, s.tmuxWindow!,
          others.some(o => o.needsAttention),
          result.status === "running" || others.some(o => o.status === "running"));
      }
      continue;
    }

    target = { paneId: s.tmuxPane, tmuxSession: s.tmuxSession, tmuxWindow: s.tmuxWindow };
    break;
  }

  // Fallback: if state had no valid candidates, scan tmux windows for ⚡ prefixes.
  // This handles desync where the window shows ⚡ but state.json doesn't know about it.
  if (!target) {
    const panes = await listPanes();
    const attentionPanes = panes.filter((p) =>
      p.windowName.startsWith(ATTENTION_PREFIX) && p.paneId !== activePaneId);

    for (const pane of attentionPanes) {
      const captured = await capturePane(pane.paneId);
      if (!captured) continue;

      const plain = captured
        .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const result = detectStatus(plain, true);

      if (result.status === "running" || result.status === "idle") {
        // Not actually needing attention — sync prefix (may restore 🔄)
        await syncWindowPrefix(pane.sessionName, pane.windowIndex, false, result.status === "running");
        continue;
      }

      target = { paneId: pane.paneId, tmuxSession: pane.sessionName, tmuxWindow: pane.windowIndex };
      break;
    }
  }

  if (!target) {
    // Neither state nor window scan found anything
    state.lastUpdatedBy = "tui";
    state.lastUpdatedAt = Date.now();
    await saveState(state);
    await displayMessage("No sessions need attention");
    return;
  }

  // Clear attention flag in state (if it exists) and save
  // Use lastUpdatedBy="tui" so the monitor defers to our state
  // and doesn't overwrite our changes on its next poll
  const stateEntry = state.sessions[target.paneId];
  if (stateEntry) {
    stateEntry.needsAttention = false;
    stateEntry.attentionType = undefined;
  }
  state.lastUpdatedBy = "tui";
  state.lastUpdatedAt = Date.now();
  await saveState(state);

  // Sync prefix on target window — may restore 🔄 if other panes are running
  const othersInWindow = Object.values(state.sessions).filter(
    (s) =>
      s.tmuxPane !== target!.paneId &&
      s.tmuxSession === target!.tmuxSession &&
      String(s.tmuxWindow) === String(target!.tmuxWindow),
  );
  await syncWindowPrefix(target.tmuxSession, target.tmuxWindow,
    othersInWindow.some(s => s.needsAttention),
    othersInWindow.some(s => s.status === "running"));

  // Switch to the pane
  await switchToPane(target.paneId, target.tmuxSession, target.tmuxWindow);

  // Jump itself is the confirmation — no toast needed.
}

// ---------------------------------------------------------------------------
// csm reset
// ---------------------------------------------------------------------------

/** Standard shell/tool names that shouldn't be renamed. */
const KEEP_NAMES = new Set(["zsh", "bash", "dev", "fish", "sh"]);

/**
 * Reset all tmux window names back to repo name.
 * Strips ⚡/🔄 prefixes and AI-generated names. Also clears attention state.
 */
export async function reset(): Promise<void> {
  try {
    // Get all panes to map windows to repo paths
    const panes = await listPanes();
    const windowRepos = new Map<string, string>();
    for (const pane of panes) {
      const wKey = `${pane.sessionName}:${pane.windowIndex}`;
      if (!windowRepos.has(wKey)) {
        const repo = pane.currentPath === home
          ? "~"
          : (pane.currentPath.split("/").pop() || "claude");
        windowRepos.set(wKey, repo);
      }
    }

    const output = await Bun.$`tmux list-windows -a -F '#{session_name}:#{window_index} #{window_name}'`
      .quiet()
      .text();
    const lines = output.trim().split("\n").filter(Boolean);
    let count = 0;

    for (const line of lines) {
      const spaceIdx = line.indexOf(" ");
      if (spaceIdx === -1) continue;
      const target = line.slice(0, spaceIdx);
      const name = line.slice(spaceIdx + 1);
      const [sessionName, windowIndex] = target.split(":");

      const cleanName = stripAllPrefixes(name);
      const wKey = `${sessionName}:${windowIndex}`;
      const repoName = windowRepos.get(wKey) ?? "claude";

      if (KEEP_NAMES.has(cleanName)) {
        // Shell/tool name — only strip prefix if present
        if (name !== cleanName) {
          await renameWindow(sessionName, parseInt(windowIndex, 10), cleanName);
          count++;
        }
      } else if (cleanName !== repoName) {
        // AI-generated, legacy "claude", or prefixed name → reset to repo name
        await renameWindow(sessionName, parseInt(windowIndex, 10), repoName);
        count++;
      } else if (name !== cleanName) {
        // Already repo name but has prefix → strip it
        await renameWindow(sessionName, parseInt(windowIndex, 10), cleanName);
        count++;
      }
    }

    // Clear all attention flags in state
    const state = await loadState();
    let cleared = false;
    for (const s of Object.values(state.sessions)) {
      if (s.needsAttention) {
        s.needsAttention = false;
        s.attentionType = undefined;
        cleared = true;
      }
    }
    if (cleared) {
      state.lastUpdatedAt = Date.now();
      await saveState(state);
    }

    console.log(`Reset ${count} window${count !== 1 ? "s" : ""}`);
  } catch {
    console.error("Failed to list tmux windows");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// csm list
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<string, string> = {
  waiting: "⏸",
  running: "⦿",
  ready: "●",
  idle: "○",
};

/**
 * Print a text-only list of active Claude sessions.
 */
export async function list(): Promise<void> {
  const [panes, processes, paneSessions] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
    loadPaneSessions(),
  ]);

  const claudeTtys = new Set(processes.map((p) => p.tty));
  const claudePanes = panes.filter((pane) => {
    const normalizedTty = pane.tty.replace(/^\/dev\//, "");
    return claudeTtys.has(normalizedTty);
  });

  if (claudePanes.length === 0) {
    console.log("No active sessions");
    return;
  }

  // Capture and detect status for each pane. Prefer event-sourced status when a
  // hook log exists (correct on scroll-up); else fall back to the viewport scraper.
  const sessions = await Promise.all(
    claudePanes.map(async (pane) => {
      const captured = await capturePane(pane.paneId);
      const plain = captured
        .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const scraper = detectStatus(plain, true);

      const sessionId = paneSessions[pane.paneId];
      const native = sessionId ? await nativeStatus(sessionId) : null;
      const eventStatus = sessionId ? await eventSourcedStatus(sessionId) : null;

      const name = stripAllPrefixes(pane.windowName);
      const repo = pane.currentPath === home
        ? "~"
        : (pane.currentPath.split("/").pop() || pane.currentPath);

      return {
        name,
        status: native ?? eventStatus ?? scraper.status,
        statusSource: native ? "native" : eventStatus ? "event" : "scraper",
        contextPercent: scraper.contextPercent,
        repo,
        needsAttention: pane.windowName.startsWith(ATTENTION_PREFIX),
      };
    }),
  );

  // Sort: attention first, then by status priority
  const statusOrder: Record<string, number> = { waiting: 0, running: 1, ready: 2, idle: 3 };
  sessions.sort((a, b) => {
    if (a.needsAttention !== b.needsAttention) return a.needsAttention ? -1 : 1;
    return (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
  });

  for (const s of sessions) {
    const icon = STATUS_ICONS[s.status] || "?";
    const attention = s.needsAttention ? " ⚡" : "";
    const ctx = s.contextPercent ? ` ${s.contextPercent}%` : "";
    console.log(
      `${icon} ${s.name.padEnd(24)} ${s.status.padEnd(8)} statusSource=${s.statusSource.padEnd(7)} ${s.repo}${ctx}${attention}`,
    );
  }
}

// ---------------------------------------------------------------------------
// csm switch <name>
// ---------------------------------------------------------------------------

/** Score a candidate name against a search needle */
function fuzzyScore(candidate: string, needle: string): number {
  if (candidate === needle) return 100;
  if (candidate.startsWith(needle)) return 80;
  if (candidate.includes(needle)) return 60;
  const words = candidate.split(/[-_\s]+/);
  if (words.some((w) => w.startsWith(needle))) return 40;
  if (isSubsequence(needle, candidate)) return 20;
  return 0;
}

/**
 * Fuzzy-match a session by name and switch to it.
 * Matches against both tmux window names and AI-generated names from the cache.
 */
export async function switchTo(name?: string): Promise<void> {
  if (!name) {
    console.error("Usage: csm switch <name>");
    process.exit(1);
  }

  const [panes, processes, nameCache, state] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
    loadNameCache(),
    loadState(),
  ]);

  // Build TTY→sessionId map for cached name lookup
  const ttyToSessionId = new Map<string, string>();
  for (const proc of processes) {
    if (proc.sessionId) ttyToSessionId.set(proc.tty, proc.sessionId);
  }

  const needle = name.toLowerCase();

  // Score each pane by best match across window name and cached name
  const scored = panes
    .map((pane) => {
      const windowName = stripAllPrefixes(pane.windowName).toLowerCase();
      let score = fuzzyScore(windowName, needle);

      // Also try matching against the AI-generated name from the cache
      const normalizedTty = pane.tty.replace(/^\/dev\//, "");
      const sessionId = ttyToSessionId.get(normalizedTty);
      if (sessionId) {
        const cachedName = nameCache.names[sessionId]?.toLowerCase();
        if (cachedName) {
          score = Math.max(score, fuzzyScore(cachedName, needle));
        }
      }

      return { pane, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    console.error(`No session matching "${name}"`);
    process.exit(1);
  }

  const best = scored[0].pane;

  // Sync prefix: clear ⚡ for this pane, but preserve 🔄 if other panes are running
  const windowPanes = Object.values(state.sessions).filter(
    (s) => s.tmuxSession === best.sessionName && String(s.tmuxWindow) === String(best.windowIndex),
  );
  await syncWindowPrefix(best.sessionName, best.windowIndex,
    windowPanes.some(s => s.needsAttention && s.tmuxPane !== best.paneId),
    windowPanes.some(s => s.status === "running"));

  await switchToPane(best.paneId, best.sessionName, best.windowIndex);
}

function isSubsequence(sub: string, str: string): boolean {
  let j = 0;
  for (let i = 0; i < str.length && j < sub.length; i++) {
    if (str[i] === sub[j]) j++;
  }
  return j === sub.length;
}

// ---------------------------------------------------------------------------
// csm setup
// ---------------------------------------------------------------------------

const HOOK_VERSION = 6;

// SessionStart pane→session mapper (existing; feeds processHookEvents).
const HOOK_SCRIPT = `#!/bin/bash
# CSM_HOOK_VERSION=${HOOK_VERSION}
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
# Only use $TMUX_PANE — never fall back to tmux display-message which returns
# the active pane, not the pane running this Claude session.
PANE_ID="$TMUX_PANE"
if [ -n "$SESSION_ID" ] && [ -n "$PANE_ID" ]; then
  mkdir -p ~/.config/csm
  printf '%s %s\\n' "$PANE_ID" "$SESSION_ID" >> ~/.config/csm/hook-events
fi
`;

// Shared event logger (Inc3). Appends the raw hook payload, one JSON object per
// line, to events/<session_id>.jsonl. Newlines in the stdin payload are collapsed
// to spaces so each event is exactly one line — JSON escapes real newlines inside
// strings (\\n), so this only flattens pretty-print formatting, never string
// contents. Trim to the last 200 lines ONLY when over budget, via atomic rename
// (.tmp + mv -f) so the ~3s concurrent readers never see a torn file; the common
// path stays a bare append (~5ms, A7).
const LOG_EVENT_SNIPPET = `INPUT=$(cat)
# Whitespace-tolerant (handles compact AND pretty-printed payloads); cut -f4 yields
# the value either way. session-start.sh keeps its proven compact-only pattern.
SESSION_ID=$(printf '%s' "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$SESSION_ID" ]; then
  DIR=~/.config/csm/events
  mkdir -p "$DIR"
  F="$DIR/$SESSION_ID.jsonl"
  LINE=$(printf '%s' "$INPUT" | tr '\\n' ' ')
  printf '%s\\n' "$LINE" >> "$F"
  LINES=$(wc -l < "$F")
  if [ "$LINES" -gt 200 ]; then
    tail -200 "$F" > "$F.tmp" && mv -f "$F.tmp" "$F"
  fi
fi`;

// Non-blocking events (UserPromptSubmit/PostToolUse/Notification/Stop/SubagentStop).
const EVENT_HOOK_SCRIPT = `#!/bin/bash
# CSM_HOOK_VERSION=${HOOK_VERSION}
# CSM event logger — see LOG_EVENT_SNIPPET.
${LOG_EVENT_SNIPPET}
`;

// PreToolUse handler. Logs the event (ADR-3b: always before the decision), then
// attach-aware approval (Inc6, A6): a tmux client attached to the session → exit
// neutral so the desk TUI prompt appears instantly (no added lag); detached →
// write pending/<id>.json and block-poll decisions/<id>.json every 500ms up to the
// 600s hook timeout, emitting the permission decision (or neutral fallthrough on
// timeout — the desk prompt is always the floor). Pure shell, no jq/new deps; the
// full tool_input is recovered by listPendingApprovals from the logged event.
const PRETOOLUSE_HOOK_SCRIPT = `#!/bin/bash
# CSM_HOOK_VERSION=${HOOK_VERSION}
# CSM PreToolUse handler — log, then attach-aware blocking approval.
${LOG_EVENT_SNIPPET}

# Derive the session from \$TMUX_PANE (A6). Outside tmux → neutral, never block.
[ -z "\$TMUX_PANE" ] && exit 0
SESS=$(tmux display-message -p -t "\$TMUX_PANE" '#{session_name}' 2>/dev/null)
[ -z "\$SESS" ] && exit 0
[ -z "\$SESSION_ID" ] && exit 0

# Attached client → fall through to the instant desk TUI prompt (no lag).
if [ -n "$(tmux list-clients -t "\$SESS" 2>/dev/null)" ]; then
  exit 0
fi

# Detached → register the pending approval and block-poll for a decision.
TOOL=$(printf '%s' "\$INPUT" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
TUID=$(printf '%s' "\$INPUT" | grep -oE '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)

# ADR-3 fix: don't block on calls Claude would auto-approve anyway, or a detached
# (autonomous/subagent-heavy) session stalls up to 600s per call. bypassPermissions
# never prompts; read-only tools never prompt in any mode. Only tools that could
# actually raise a prompt reach the block-poll below.
PERM=$(printf '%s' "\$INPUT" | grep -oE '"permission_mode"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
[ "\$PERM" = "bypassPermissions" ] && exit 0
case "\$TOOL" in
  Read|Glob|Grep|NotebookRead|TodoWrite|Task) exit 0 ;;
esac

TS=$(( $(date +%s) * 1000 ))
PDIR=~/.config/csm/pending
DFILE=~/.config/csm/decisions/"\$SESSION_ID".json
mkdir -p "\$PDIR"
printf '{"sessionId":"%s","ts":%s,"tool":"%s","tool_use_id":"%s"}\\n' "\$SESSION_ID" "\$TS" "\$TOOL" "\$TUID" > "\$PDIR/\$SESSION_ID".json

i=0
while [ "\$i" -lt 1200 ]; do          # 1200 × 0.5s = 600s (the hook timeout)
  if [ -f "\$DFILE" ]; then
    DECISION=$(grep -oE '"decision"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
    REASON=$(grep -oE '"reason"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
    rm -f "\$DFILE" "\$PDIR/\$SESSION_ID".json
    if [ "\$DECISION" = "allow" ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\\n'
      exit 0
    elif [ "\$DECISION" = "deny" ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "\$REASON"
      exit 0
    fi
  fi
  sleep 0.5
  i=$(( i + 1 ))
done

# Timeout → neutral fallthrough to the desk TUI prompt (nothing stranded).
rm -f "\$PDIR/\$SESSION_ID".json
exit 0
`;

/** Hook scripts CSM installs under ~/.config/csm/hooks. */
const HOOK_SCRIPTS = [
  { name: "session-start.sh", content: HOOK_SCRIPT },
  { name: "event.sh", content: EVENT_HOOK_SCRIPT },
  { name: "pretooluse.sh", content: PRETOOLUSE_HOOK_SCRIPT },
] as const;

/** Which hook script handles each Claude Code event. PreToolUse blocks (Inc6). */
const HOOK_REGISTRATIONS: { event: string; script: string; timeout?: number }[] = [
  { event: "SessionStart", script: "session-start.sh" },
  { event: "UserPromptSubmit", script: "event.sh" },
  { event: "PostToolUse", script: "event.sh" },
  { event: "Notification", script: "event.sh" },
  { event: "Stop", script: "event.sh" },
  { event: "SubagentStop", script: "event.sh" },
  { event: "PreToolUse", script: "pretooluse.sh", timeout: 600 },
];

/** Read the CSM_HOOK_VERSION from an installed hook script. Returns 0 if missing or unreadable. */
async function getInstalledHookVersion(hookPath: string): Promise<number> {
  try {
    const content = await Bun.file(hookPath).text();
    const match = content.match(/^# CSM_HOOK_VERSION=(\d+)/m);
    return match ? parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Install the CSM hooks into ~/.claude/settings.json and create the hook scripts.
 *
 * Registers exactly ONE command per event (ADR-3b): SessionStart → pane-map,
 * the five non-blocking events → `event.sh` (log), PreToolUse → `pretooluse.sh`
 * (log now; blocking approval in Inc6). Safe to run multiple times — rewrites
 * outdated scripts and adds only missing registrations, so a second run is a
 * no-op (exactly one CSM entry per event; user hooks preserved).
 */
export async function setup(): Promise<void> {
  const { homedir } = await import("os");
  const home = process.env.CSM_HOME ?? homedir(); // CSM_HOME: test seam (see config.ts)
  const settingsPath = `${home}/.claude/settings.json`;
  const hookDir = `${home}/.config/csm/hooks`;
  const scriptPath = (name: string) => `${hookDir}/${name}`;

  // Load existing settings (or start fresh)
  let settings: Record<string, any> = {};
  try {
    settings = JSON.parse(await Bun.file(settingsPath).text());
  } catch {
    // No settings file or malformed — start fresh
  }
  if (!settings.hooks) settings.hooks = {};

  // Rewrite any missing/outdated script (version gate is per-script).
  await Bun.$`mkdir -p ${hookDir}`.quiet();
  let scriptsWritten = 0;
  let scriptsUpdated = false;
  for (const { name, content } of HOOK_SCRIPTS) {
    const path = scriptPath(name);
    const installed = await getInstalledHookVersion(path);
    if (installed < HOOK_VERSION) {
      await Bun.write(path, content);
      await Bun.$`chmod +x ${path}`.quiet();
      scriptsWritten++;
      if (installed > 0) scriptsUpdated = true;
    }
  }

  // Ensure each event has exactly one CSM registration. Match on the full script
  // path (a stable idempotency key) so a re-run never duplicates an entry.
  let settingsChanged = false;
  for (const { event, script, timeout } of HOOK_REGISTRATIONS) {
    const path = scriptPath(script);
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const present = settings.hooks[event].some(
      (entry: any) =>
        Array.isArray(entry.hooks) &&
        entry.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(path)),
    );
    if (!present) {
      const hook: Record<string, unknown> = { type: "command", command: path };
      if (timeout !== undefined) hook.timeout = timeout;
      settings.hooks[event].push({ hooks: [hook] }); // omit matcher → all events/tools
      settingsChanged = true;
    }
  }

  if (settingsChanged) {
    await Bun.$`mkdir -p ${home}/.claude`.quiet();
    await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  }

  if (!scriptsWritten && !settingsChanged) {
    console.log("CSM hooks already configured.");
    return;
  }

  console.log(scriptsUpdated ? "CSM hooks updated." : "CSM hooks installed.");
  console.log(`  Hook scripts: ${hookDir}/{session-start,event,pretooluse}.sh`);
  console.log(`  Settings: ${settingsPath}`);
  console.log("\nNew Claude Code sessions will now emit status/transcript events.");
}

// ---------------------------------------------------------------------------
// csm save-sessions  (tmux-resurrect post-save hook)
// ---------------------------------------------------------------------------

const RESURRECT_SESSIONS_PATH = `${PATHS.dir}/resurrect-sessions.json`;

interface ResurrectSessionEntry {
  sessionId: string;
  cwd: string;
}

interface ResurrectSessionMap {
  savedAt: string;
  sessions: Record<string, ResurrectSessionEntry>;
}

/**
 * Snapshot current pane→Claude session mappings using tmux coordinates
 * (session:window.pane_index) that survive a tmux server restart.
 *
 * Designed to be called by tmux-resurrect's @resurrect-hook-post-save-all.
 * Can also be run manually before a planned restart.
 */
export async function saveSessions(): Promise<void> {
  const paneSessions = await loadPaneSessions();
  if (Object.keys(paneSessions).length === 0) {
    // Nothing tracked — skip silently (hook context)
    return;
  }

  // Get all panes with their stable coordinates + pane_id
  let paneCoords: Array<{ paneId: string; coord: string; cwd: string }>;
  try {
    const output = await Bun.$`tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{pane_current_path}'`
      .quiet()
      .text();
    paneCoords = output.trim().split("\n").filter(Boolean).map((line) => {
      const [paneId, coord, ...cwdParts] = line.split(" ");
      return { paneId, coord, cwd: cwdParts.join(" ") };
    });
  } catch {
    return;
  }

  // Build coordinate→sessionId map from paneSessions (keyed by pane ID)
  const sessions: Record<string, ResurrectSessionEntry> = {};
  for (const { paneId, coord, cwd } of paneCoords) {
    const sessionId = paneSessions[paneId];
    if (sessionId) {
      sessions[coord] = { sessionId, cwd };
    }
  }

  if (Object.keys(sessions).length === 0) return;

  const map: ResurrectSessionMap = {
    savedAt: new Date().toISOString(),
    sessions,
  };

  try {
    await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
    await Bun.write(RESURRECT_SESSIONS_PATH, JSON.stringify(map, null, 2));
  } catch {
    // Non-fatal — running in hook context
  }
}

// ---------------------------------------------------------------------------
// csm restore-sessions  (tmux-resurrect post-restore hook)
// ---------------------------------------------------------------------------

/**
 * Restore Claude Code sessions after tmux-resurrect restores panes.
 *
 * Reads the coordinate→sessionId mapping saved by `csm save-sessions`,
 * matches coordinates to newly created panes, and launches
 * `claude --resume=<id>` in each via tmux send-keys.
 *
 * Designed to be called by tmux-resurrect's @resurrect-hook-post-restore-all.
 * Can also be run manually after a restore.
 */
export async function restoreSessions(): Promise<void> {
  // Read saved mapping
  let map: ResurrectSessionMap;
  try {
    const raw = await Bun.file(RESURRECT_SESSIONS_PATH).text();
    map = JSON.parse(raw);
  } catch {
    console.log("No saved session map found. Run 'csm save-sessions' first or configure the tmux-resurrect hook.");
    return;
  }

  if (!map.sessions || Object.keys(map.sessions).length === 0) {
    console.log("No Claude sessions to restore.");
    return;
  }

  // Get current panes with their coordinates
  let paneCoords: Array<{ paneId: string; coord: string; cwd: string }>;
  try {
    const output = await Bun.$`tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{pane_current_path}'`
      .quiet()
      .text();
    paneCoords = output.trim().split("\n").filter(Boolean).map((line) => {
      const [paneId, coord, ...cwdParts] = line.split(" ");
      return { paneId, coord, cwd: cwdParts.join(" ") };
    });
  } catch {
    console.error("Failed to list tmux panes.");
    return;
  }

  // Match coordinates and launch claude in matching panes
  let restored = 0;
  let skipped = 0;

  for (const { paneId, coord } of paneCoords) {
    const entry = map.sessions[coord];
    if (!entry) continue;

    // Verify the pane is a shell (not already running something).
    // Check if there's a foreground process other than the shell.
    try {
      const cmd = (await Bun.$`tmux display-message -t ${paneId} -p '#{pane_current_command}'`.quiet().text()).trim();
      if (cmd && !["zsh", "bash", "fish", "sh"].includes(cmd)) {
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }

    // Launch claude --resume in this pane
    try {
      await Bun.$`tmux send-keys -t ${paneId} ${`claude --resume=${entry.sessionId}`} Enter`.quiet();
      restored++;
    } catch {
      skipped++;
    }
  }

  if (restored > 0) {
    console.log(`Restored ${restored} Claude session${restored !== 1 ? "s" : ""}.`);
  }
  if (skipped > 0) {
    console.log(`Skipped ${skipped} pane${skipped !== 1 ? "s" : ""} (already running or inaccessible).`);
  }
  if (restored === 0 && skipped === 0) {
    console.log("No matching panes found for saved sessions.");
  }
}
