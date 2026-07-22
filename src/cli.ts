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
import { loadState, saveState, loadPaneSessions, migratePaneMap } from "./core/state";
import { switchToPane, listPanes, renameWindow, capturePane, displayMessage, atMacFocus } from "./core/tmux";
import { syncWindowPrefix, stripAllPrefixes, ATTENTION_PREFIX } from "./core/notifications";
import { findClaudeProcesses } from "./core/process";
import { detectStatus } from "./core/status";
import { eventSourcedStatus } from "./core/hook-events";
import { nativeStatus } from "./core/session-state";
import { loadNameCache, slugify } from "./core/names";
import { PATHS } from "./core/config";
import { pickSavedCwd, resolveRestoreTarget } from "./core/resurrect";
import { pickRepoPath } from "./core/sessions";
import { resolveTranscriptPath, latestTranscriptCwd } from "./core/last-turn";
import { shellQuote } from "./core/launch-command";
import { PENDING_DIR, DECISIONS_DIR, HOLD_WINDOW_MS, QUESTION_HOLD_MS, HOOK_KILL_GRACE_MS } from "./core/approval";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";

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

  // Map each tty to its claude process (prefer one with a resolved sessionId) so a
  // fork pane can use its real, native-resolved id instead of the parent id the hook
  // recorded (see resolvePaneSessionId / nativeSessionIdByPid).
  const procByTty = new Map<string, typeof processes[0]>();
  for (const proc of processes) {
    const existing = procByTty.get(proc.tty);
    if (!existing || proc.sessionId) procByTty.set(proc.tty, proc);
  }
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

      // A fork's hook-owned map entry is the PARENT id; its native-resolved id
      // (proc.sessionId) wins so it doesn't render the parent's running status.
      const proc = procByTty.get(pane.tty.replace(/^\/dev\//, ""));
      const sessionId = proc?.isFork
        ? (proc.sessionId ?? paneSessions[pane.paneId])
        : paneSessions[pane.paneId];
      const native = sessionId ? await nativeStatus(sessionId) : null;
      const eventStatus = sessionId ? await eventSourcedStatus(sessionId) : null;

      const name = stripAllPrefixes(pane.windowName);
      // A pane restored by tmux-resurrect comes back in $HOME, so its cwd would render every
      // such session as "~". Claude's own last-recorded cwd is the authority there — same
      // rule the TUI applies (pickRepoPath).
      const transcript = sessionId && pane.currentPath === home
        ? await resolveTranscriptPath(sessionId)
        : null;
      const repoPath = pickRepoPath(
        pane.currentPath,
        transcript ? await latestTranscriptCwd(transcript) : null,
      );
      const repo = repoPath === home
        ? "~"
        : (repoPath.split("/").pop() || repoPath);

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
        const cachedName = nameCache.names[sessionId];
        if (cachedName) {
          // Match against both the normalized name ("fix auth") and its tmux slug
          // ("fix-auth") — the user likely types the slug shown on the tab.
          score = Math.max(score, fuzzyScore(cachedName.toLowerCase(), needle), fuzzyScore(slugify(cachedName), needle));
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

const HOOK_VERSION = 13;

// SessionStart pane→session mapper. Writes one file per pane (panes/<paneId> → sessionId)
// atomically (temp+rename) — the hook OWNS the map, so there's no shared-file write race and
// no consume-once log for readers to fight over (v6 appended to a truncate-once hook-events
// file that only the monitor persisted, leaving sessions listed-but-unsendable).
const HOOK_SCRIPT = `#!/bin/bash
# CSM_HOOK_VERSION=${HOOK_VERSION}
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
# Only use $TMUX_PANE — never fall back to tmux display-message which returns
# the active pane, not the pane running this Claude session.
PANE_ID="$TMUX_PANE"
if [ -n "$SESSION_ID" ] && [ -n "$PANE_ID" ]; then
  D=~/.config/csm/panes
  mkdir -p "$D"
  printf '%s' "$SESSION_ID" > "$D/$PANE_ID.tmp" && mv "$D/$PANE_ID.tmp" "$D/$PANE_ID"
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
# CSM PreToolUse handler — log, then attach-aware blocking approval
# (AskUserQuestion is delegated to question-pretooluse.sh).
${LOG_EVENT_SNIPPET}

# Derive the session from \$TMUX_PANE (A6). Outside tmux → neutral, never block.
[ -z "\$TMUX_PANE" ] && exit 0
SESS=$(tmux display-message -p -t "\$TMUX_PANE" '#{session_name}' 2>/dev/null)
[ -z "\$SESS" ] && exit 0
[ -z "\$SESSION_ID" ] && exit 0

# Tool + tool_use_id, derived once for the approval block-poll below.
TOOL=$(printf '%s' "\$INPUT" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
TUID=$(printf '%s' "\$INPUT" | grep -oE '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)

# AskUserQuestion is handled by question-pretooluse.sh — a separate, matcher-scoped
# registration whose kill timeout matches the hours-long question hold. This script's
# short timeout must keep applying to every ordinary tool call (a hung approval hook
# blocks the whole session), so the question path exits here — AFTER the log above,
# which is the event line portkey mirrors, written exactly once.
[ "\$TOOL" = "AskUserQuestion" ] && exit 0

# Attached client → fall through to the instant desk TUI prompt (no lag).
if [ -n "$(tmux list-clients -t "\$SESS" 2>/dev/null)" ]; then
  exit 0
fi

# Detached → register the pending approval and block-poll for a decision.
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
# \$\$ stamps the poller's pid: readers treat a marker whose process is gone as abandoned
# (killed hook) and drive the on-screen prompt instead of writing a decision nobody reads.
printf '{"sessionId":"%s","ts":%s,"pid":%s,"tool":"%s","tool_use_id":"%s"}\\n' "\$SESSION_ID" "\$TS" "\$\$" "\$TOOL" "\$TUID" > "\$PDIR/\$SESSION_ID".json

# Poll to a DEADLINE, not an iteration count: each pass forks several greps, so a counted
# loop runs well past the window and gets killed by the hook timeout before it can reach
# the cleanup below — which is what strands a marker and makes readers see a phantom hold.
END=\$(( \$(date +%s) + ${HOLD_WINDOW_MS / 1000} ))
while [ "\$(date +%s)" -lt "\$END" ]; do
  if [ -f "\$DFILE" ]; then
    KIND=$(grep -oE '"kind"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
    DTUID=$(grep -oE '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' "\$DFILE" | head -1 | cut -d'"' -f4)
    # Consume only our OWN approval decision: skip a stale question decision, and skip
    # an approval whose tool_use_id (when present) belongs to a different call.
    if [ "\$KIND" != "question" ] && { [ -z "\$DTUID" ] || [ "\$DTUID" = "\$TUID" ]; }; then
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
  fi
  sleep 0.5
done

# Timeout → neutral fallthrough to the desk TUI prompt (nothing stranded).
rm -f "\$PDIR/\$SESSION_ID".json
exit 0
`;

// AskUserQuestion intercept, split from pretooluse.sh so its registration can carry the
// hours-long question-hold timeout without also letting a hung approval hook block a
// session for hours. Registered with matcher "AskUserQuestion" (pretooluse.sh logs the
// event and exits for this tool, so the gates below run exactly once per question).
// Checks run cheap→expensive; ANY miss or ambiguity exits 0 (native widget) — never hold
// a session hostage when unsure. No claude-version gate: updatedInput.answers is assumed
// forward-compatible; if a future claude breaks it the phone-answer just won't take
// (visibly degraded) rather than silently reverting the feature on every patch bump.
const QUESTION_PRETOOLUSE_HOOK_SCRIPT = `#!/bin/bash
# CSM_HOOK_VERSION=${HOOK_VERSION}
# CSM AskUserQuestion handler — focus-aware intercept (event logging stays in pretooluse.sh).
INPUT=$(cat)
[ -z "\$TMUX_PANE" ] && exit 0
SESS=$(tmux display-message -p -t "\$TMUX_PANE" '#{session_name}' 2>/dev/null)
[ -z "\$SESS" ] && exit 0

# 1. CSM-tracked pane (rules out an ad-hoc bare-terminal claude).
[ -f "\$HOME/.config/csm/panes/\$TMUX_PANE" ] || exit 0
# 2. Live bridge consumer: marker mtime <=40s (tolerates one missed 15s heartbeat).
#    Stale/absent → nobody can answer → native widget, no long stall.
M="\$HOME/.config/csm/bridge-consumer"
MT=$(stat -f %m "\$M" 2>/dev/null || echo 0)
if [ "\$MT" = 0 ] || [ $(( $(date +%s) - MT )) -ge 40 ]; then exit 0; fi
# 3. Focus (three-part): active window + attached client (cheap tmux), and only then
#    the frontmost app (lsappinfo — no TCC prompt, unlike osascript). All three true
#    ⇒ you're looking ⇒ let the native widget render. Same probes as atMacFocus() in
#    core/tmux.ts (the hold's release check) — keep the two in sync, but note the
#    OPPOSITE failure polarity: here ambiguity means "don't intercept".
WA=$(tmux display-message -p -t "\$TMUX_PANE" '#{window_active}' 2>/dev/null)
CL=$(tmux list-clients -t "\$SESS" 2>/dev/null)
if [ "\$WA" = "1" ] && [ -n "\$CL" ]; then
  FRONT=$(lsappinfo info -only name "$(lsappinfo front)" 2>/dev/null)
  # Fail toward native: unreadable/empty frontmost ⇒ treat as focused (exit 0). Only a
  # positively-identified OTHER app frontmost (you're on your phone) is NOT focused.
  case "\$FRONT" in
    ''|*'"Ghostty"'*) exit 0 ;;
  esac
fi
# All gates passed → hold and answer via the file channel (releases early on refocus).
printf '%s' "\$INPUT" | csm question-hook
exit \$?
`;

/** Hook scripts CSM installs under ~/.config/csm/hooks. */
const HOOK_SCRIPTS = [
  { name: "session-start.sh", content: HOOK_SCRIPT },
  { name: "event.sh", content: EVENT_HOOK_SCRIPT },
  { name: "pretooluse.sh", content: PRETOOLUSE_HOOK_SCRIPT },
  { name: "question-pretooluse.sh", content: QUESTION_PRETOOLUSE_HOOK_SCRIPT },
] as const;

/** Which hook script handles each Claude Code event. PreToolUse blocks (Inc6). */
const HOOK_REGISTRATIONS: { event: string; script: string; matcher?: string; timeout?: number }[] = [
  { event: "SessionStart", script: "session-start.sh" },
  { event: "UserPromptSubmit", script: "event.sh" },
  { event: "PostToolUse", script: "event.sh" },
  { event: "Notification", script: "event.sh" },
  { event: "Stop", script: "event.sh" },
  { event: "SubagentStop", script: "event.sh" },
  // Claude Code's own timeout — the SIGKILL each hook poll loop races. Deliberately the
  // poll window PLUS a grace: Claude counts from spawn and a loop can't start its clock
  // until the process is up, so registering the bare window would make the kill land first
  // and strand the marker the loop's cleanup would have removed. Two entries on purpose:
  // the matcher-scoped question hold may run for hours, while every other tool call must
  // stay killable at ~10 min.
  {
    event: "PreToolUse",
    script: "pretooluse.sh",
    timeout: (HOLD_WINDOW_MS + HOOK_KILL_GRACE_MS) / 1000,
  },
  {
    event: "PreToolUse",
    script: "question-pretooluse.sh",
    matcher: "AskUserQuestion",
    timeout: (QUESTION_HOLD_MS + HOOK_KILL_GRACE_MS) / 1000,
  },
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

  // Fold the pre-v7 single-file map (+ residual hook-events) into per-pane files so sessions
  // already running at upgrade time stay resolvable. Idempotent — a no-op once migrated.
  await migratePaneMap();

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
  for (const { event, script, matcher, timeout } of HOOK_REGISTRATIONS) {
    const path = scriptPath(script);
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
    const existing = settings.hooks[event]
      .flatMap((entry: any) => (Array.isArray(entry.hooks) ? entry.hooks : []))
      .find((h: any) => typeof h.command === "string" && h.command.includes(path));
    if (!existing) {
      const hook: Record<string, unknown> = { type: "command", command: path };
      if (timeout !== undefined) hook.timeout = timeout;
      const entry: Record<string, unknown> = { hooks: [hook] };
      if (matcher !== undefined) entry.matcher = matcher; // omit matcher → all events/tools
      settings.hooks[event].push(entry);
      settingsChanged = true;
    } else if (timeout !== undefined && existing.timeout !== timeout) {
      // Reconcile, don't just add: the registration is matched on command path, so an
      // install from an older version keeps its stale timeout forever otherwise — and that
      // timeout is the kill deadline the hook's own poll window has to stay inside.
      existing.timeout = timeout;
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
  console.log(`  Hook scripts: ${hookDir}/{session-start,event,pretooluse,question-pretooluse}.sh`);
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

  // Whatever the previous snapshot recorded, so a pane that came back in $HOME can't
  // overwrite a real repo path with it (see pickSavedCwd).
  const previousCwdBySession = new Map<string, string>();
  try {
    const prior = JSON.parse(await Bun.file(RESURRECT_SESSIONS_PATH).text()) as ResurrectSessionMap;
    for (const entry of Object.values(prior.sessions ?? {})) {
      previousCwdBySession.set(entry.sessionId, entry.cwd);
    }
  } catch {
    // no prior map (first save) or unreadable — every pane cwd is taken as-is
  }

  // Build coordinate→sessionId map from paneSessions (keyed by pane ID)
  const sessions: Record<string, ResurrectSessionEntry> = {};
  for (const { paneId, coord, cwd } of paneCoords) {
    const sessionId = paneSessions[paneId];
    if (sessionId) {
      sessions[coord] = { sessionId, cwd: pickSavedCwd(cwd, previousCwdBySession.get(sessionId)) };
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
  // A session id can sit at two coordinates (e.g. it was resumed into a second pane before
  // the last save). Resuming it twice leaves two processes fighting over one transcript.
  const launched = new Set<string>();

  for (const { paneId, coord } of paneCoords) {
    const entry = map.sessions[coord];
    if (!entry) continue;
    if (launched.has(entry.sessionId)) {
      skipped++;
      continue;
    }

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

    // Launch claude --resume in this pane, in the session's own directory. A restored pane
    // starts wherever the shell drops it (often $HOME), and resuming there roots Claude at
    // $HOME. `;` rather than `&&` so a `cd` that somehow fails still leaves the session
    // resumed — degraded, not missing.
    // Resolving the directory touches the filesystem (and may consolidate a moved transcript).
    // A throw here must cost this one pane its cwd, not abort the loop and leave every later
    // pane unrestored — so it degrades to the bare resume this command has always done.
    const dir = await resolveRestoreTarget(entry.sessionId, entry.cwd).catch(() => null);
    const cmd = dir
      ? `cd ${shellQuote(dir)}; claude --resume=${entry.sessionId}`
      : `claude --resume=${entry.sessionId}`;
    try {
      await Bun.$`tmux send-keys -t ${paneId} ${cmd} Enter`.quiet();
      launched.add(entry.sessionId);
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

// ---------------------------------------------------------------------------
// csm question-hook (invoked by pretooluse.sh for an intercepted AskUserQuestion)
// ---------------------------------------------------------------------------

/**
 * `csm question-hook` — invoked by `pretooluse.sh` ONLY for an intercept-eligible
 * AskUserQuestion (tracked pane + live phone + not focused).
 * Reads the hook stdin, registers a `pending/<session_id>.json` (kind:"question")
 * marker so both surfaces know a question is held, then block-polls
 * `decisions/<session_id>.json` for a matching decision (every 500ms, to the end of the
 * question window). Four outcomes: an answer emits `updatedInput.answers` (keyed by
 * question text) so Claude resolves the tool with no native widget; a `clarify` decision
 * ("Chat about this") denies the tool so the agent yields the turn and waits for a typed
 * message; the user returning to the Mac releases the hold (exit 0 neutral → the native
 * picker renders in front of them); expiry exits 0 neutral the same way. The native
 * picker no longer times out on its own (verified on Claude Code 2.1.217 — see ADR 8),
 * so a fallen-through question waits indefinitely and stays answerable from both
 * surfaces. stdin is parsed with JSON.parse, not shell greps — arbitrary question/label
 * text needs real JSON escaping.
 */
export async function questionHook(): Promise<void> {
  let input: any;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0); // unreadable stdin → neutral (native widget)
  }
  const sessionId: string = input?.session_id ?? "";
  const toolUseId: string = input?.tool_use_id ?? "";
  const questions = input?.tool_input?.questions;
  if (!sessionId || !toolUseId || !Array.isArray(questions)) process.exit(0);

  const pendingFile = `${PENDING_DIR}/${sessionId}.json`;
  const decisionFile = `${DECISIONS_DIR}/${sessionId}.json`;
  try {
    mkdirSync(PENDING_DIR, { recursive: true });
    writeFileSync(
      pendingFile,
      JSON.stringify({
        sessionId,
        ts: Date.now(),
        // Liveness stamp: once this process is gone the hold is abandoned and the
        // question has fallen through to the native widget, so answers must be sent as
        // keystrokes rather than written to `decisions/` where nobody is polling.
        pid: process.pid,
        kind: "question",
        tool_use_id: toolUseId,
        tool: "AskUserQuestion",
      }),
    );
  } catch {
    process.exit(0); // can't register the hold → neutral
  }

  // Poll to a DEADLINE, not an iteration count: per-pass IO makes a counted loop overrun
  // the window, so it'd still be polling when the hook timeout kills it — and the cleanup
  // below, which un-registers the hold, would never run.
  const paneId = process.env.TMUX_PANE ?? "";
  let lastFocusCheck = 0;
  const deadline = Date.now() + QUESTION_HOLD_MS;
  while (Date.now() < deadline) {
    // Focus-release: the moment the user is back at the Mac, stop holding and exit
    // neutral so the native picker renders in front of them (~1s). Checked AFTER the
    // decision read below on the previous iteration, so an answer that raced the
    // user's return has already won. Throttled to ~1s — atMacFocus shells out to
    // tmux + lsappinfo. Probe ambiguity keeps holding (see atMacFocus polarity).
    if (paneId && Date.now() - lastFocusCheck >= 1_000) {
      lastFocusCheck = Date.now();
      if (await atMacFocus(paneId)) {
        rmSync(pendingFile, { force: true });
        process.exit(0);
      }
    }
    try {
      const raw = JSON.parse(readFileSync(decisionFile, "utf8"));
      if (raw.kind === "question" && raw.tool_use_id === toolUseId) {
        rmSync(decisionFile, { force: true });
        rmSync(pendingFile, { force: true });
        if (raw.clarify === true) {
          // "Chat about this": deny the tool so the agent yields the turn and waits for
          // the user's message, instead of picking an option (mirrors the native widget).
          const asked = questions.map((q: any) => `- "${q.question}"`).join("\n");
          const reason =
            "The user wants to discuss these questions before answering, rather than pick one of the " +
            "offered options. Do NOT re-ask or restate the question yet. Wait for the user's next " +
            "message and take it into account before proceeding.\n\nQuestions asked:\n" +
            asked;
          process.stdout.write(
            JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: reason,
              },
            }),
          );
          process.exit(0);
        }
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              updatedInput: { questions, answers: raw.answers ?? {} },
            },
          }),
        );
        process.exit(0);
      }
    } catch {
      // no decision yet (or a torn/mismatched file) — keep waiting
    }
    await Bun.sleep(500);
  }

  rmSync(pendingFile, { force: true });
  process.exit(0); // timeout → neutral → native-widget floor
}
