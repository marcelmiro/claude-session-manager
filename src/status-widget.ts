/**
 * CSM Status Widget — lightweight poll for tmux status-right.
 *
 * Called by tmux every `status-interval` seconds (e.g. 5s).
 * Detects session transitions, fires notifications, outputs widget text to stdout.
 * Replaces the background monitor daemon — tmux IS the scheduler.
 */

import { listPanes, capturePane, renameWindow } from "./core/tmux";
import { findClaudeProcesses } from "./core/process";
import { detectStatus, type SessionStatus } from "./core/status";
import { loadConfig, PATHS } from "./core/config";
import { loadState, saveState, computeAggregate, buildSessionStates } from "./core/state";
import { detectTransitions, dispatchNotifications, ATTENTION_PREFIX, RUNNING_PREFIX, stripAllPrefixes, desiredPrefix } from "./core/notifications";
import type { Session, AggregateStatus } from "./types";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Debug logging — only active when ~/.config/csm/debug.log exists
// ---------------------------------------------------------------------------

const DEBUG_LOG_PATH = `${PATHS.dir}/debug.log`;
let debugEnabled: boolean | null = null;

async function debugLog(msg: string): Promise<void> {
  if (debugEnabled === null) debugEnabled = existsSync(DEBUG_LOG_PATH);
  if (!debugEnabled) return;
  try {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const line = `${ts} ${msg}\n`;
    const file = Bun.file(DEBUG_LOG_PATH);
    const existing = await file.exists() ? await file.text() : "";
    // Auto-truncate: keep last 900 lines when over 1000
    const lines = existing.split("\n");
    const trimmed = lines.length > 1000 ? lines.slice(-900).join("\n") + "\n" : existing;
    await Bun.write(DEBUG_LOG_PATH, trimmed + line);
  } catch {
    // Non-fatal — disable for rest of this run
    debugEnabled = false;
  }
}

/**
 * Quick-discover active Claude sessions. Much lighter than discoverSessions() —
 * skips index files, archive scanning, lsof, git branch, name resolution.
 * Only needs: which panes have Claude, what status are they in.
 */
async function quickDiscoverActive(): Promise<Session[]> {
  const [panes, processes] = await Promise.all([
    listPanes(),
    findClaudeProcesses({ skipSessionIds: true }),
  ]);

  // Build TTY set of Claude processes
  const claudeTtys = new Set(processes.map((p) => p.tty));

  // Find panes with Claude processes
  const claudePanes = panes.filter((pane) => {
    const normalizedTty = pane.tty.replace(/^\/dev\//, "");
    return claudeTtys.has(normalizedTty);
  });

  // Capture and detect status for each pane in parallel
  return Promise.all(
    claudePanes.map(async (pane): Promise<Session> => {
      const captured = await capturePane(pane.paneId);
      // Strip ANSI for status detection
      const plain = captured
        .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const result = detectStatus(plain, true);

      return {
        id: "",
        repo: "",
        repoPath: pane.currentPath,
        baseRepoPath: pane.currentPath,
        branch: "",
        status: result.status,
        contextPercent: result.contextPercent ?? 0,
        messageCount: 0,
        summary: "",
        modified: new Date(),
        firstPrompt: "",
        name: stripAllPrefixes(pane.windowName),
        tmuxPane: {
          paneId: pane.paneId,
          windowIndex: pane.windowIndex,
          sessionName: pane.sessionName,
          windowName: pane.windowName,
        },
      };
    }),
  );
}

function formatWidget(aggregate: AggregateStatus): string {
  const parts: string[] = [];
  if (aggregate.needsAttention > 0) parts.push(`⚡ ${aggregate.needsAttention}`);
  if (aggregate.running > 0) parts.push(`🔄 ${aggregate.running}`);
  return parts.join(" ");
}

async function main(): Promise<void> {
  const [config, state] = await Promise.all([loadConfig(), loadState()]);

  // Auto-clear: strip ⚡ from the window the user is currently viewing.
  // Runs BEFORE the tuiRecent check so it works even while the TUI is active.
  // Cost: ~6ms (two lightweight tmux queries), negligible vs 5s status-interval.
  let activePaneId: string | undefined;
  let activeWindow: string | undefined;
  let activeSession: string | undefined;
  try {
    const client = (await Bun.$`tmux list-clients -F '#{client_name}'`.quiet().text()).trim().split("\n")[0];
    if (client) {
      const info = (await Bun.$`tmux display-message -c ${client} -p '#{pane_id}:#{window_index}:#{session_name}:#{window_name}'`.quiet().text()).trim();
      const colonIdx1 = info.indexOf(":");
      const colonIdx2 = info.indexOf(":", colonIdx1 + 1);
      const colonIdx3 = info.indexOf(":", colonIdx2 + 1);
      activePaneId = info.slice(0, colonIdx1);
      activeWindow = info.slice(colonIdx1 + 1, colonIdx2);
      activeSession = info.slice(colonIdx2 + 1, colonIdx3);
      const activeWindowName = info.slice(colonIdx3 + 1);

      // Strip ⚡ from active window — but only if no OTHER panes in the window
      // still need attention (pane-level awareness for split panes).
      if (activeWindowName?.startsWith(ATTENTION_PREFIX)) {
        const otherPanesHaveAttention = Object.values(state.sessions).some(
          (s) =>
            s.needsAttention &&
            s.tmuxPane !== activePaneId &&
            s.tmuxSession === activeSession &&
            String(s.tmuxWindow) === activeWindow,
        );
        if (!otherPanesHaveAttention) {
          await debugLog(`auto-clear ⚡ on active window ${activeSession}:${activeWindow} (${activeWindowName})`);
          await renameWindow(activeSession!, parseInt(activeWindow!, 10), stripAllPrefixes(activeWindowName));
        }
      }
    }
  } catch {
    // Not in tmux context
  }

  // If TUI updated state recently, just output from its data — don't re-poll.
  // Don't save state here to avoid race with TUI's 3s writes — TUI will
  // clear attention on its own within one cycle.
  const tuiRecent = state.lastUpdatedBy === "tui" && (Date.now() - state.lastUpdatedAt) < 10_000;
  if (tuiRecent) {
    await debugLog(`freshState bail: TUI updated ${Date.now() - state.lastUpdatedAt}ms ago`);
    const aggregate = computeAggregate(state);
    process.stdout.write(formatWidget(aggregate));
    return;
  }

  // Quick poll active sessions
  const sessions = await quickDiscoverActive();
  await debugLog(`discovered ${sessions.length} sessions: ${sessions.map((s) => `${s.tmuxPane!.paneId}=${s.status}`).join(", ") || "(none)"}`);


  // Rebuild previous statuses from saved state
  const previousStatuses = new Map<string, SessionStatus>();
  for (const [key, s] of Object.entries(state.sessions)) {
    previousStatuses.set(key, s.status as SessionStatus);
  }

  // Detect transitions
  const transitions = detectTransitions(previousStatuses, sessions);
  for (const t of transitions) {
    await debugLog(`transition ${t.sessionKey}: ${t.previousStatus}→${t.currentStatus} (${t.classification})`);
  }

  // Carry over existing attention flags from state
  const needsAttention = new Set<string>();
  const attentionTypes = new Map<string, "blocked" | "turnComplete">();
  // Build a quick lookup of current statuses
  const currentStatusMap = new Map(sessions.map((s) => [s.tmuxPane!.paneId, s.status]));
  for (const [key, s] of Object.entries(state.sessions)) {
    if (s.needsAttention) {
      const currentStatus = currentStatusMap.get(key);
      // Clear stale attention: if session went back to running, user already interacted
      if (currentStatus === "running") {
        await debugLog(`carry-over ${key}: cleared (now running)`);
        continue;
      }
      // Clear if pane no longer exists
      if (!currentStatus) {
        await debugLog(`carry-over ${key}: cleared (pane gone)`);
        continue;
      }
      await debugLog(`carry-over ${key}: preserved (status=${currentStatus})`);
      needsAttention.add(key);
      if (s.attentionType) attentionTypes.set(key, s.attentionType);
    }
  }

  // Add new attention from transitions (exclude active pane — user is already looking at it,
  // and flaky status detection can cause running↔ready oscillation that re-adds attention)
  const notable = transitions.filter(
    (e) => e.classification !== "none" && e.sessionKey !== activePaneId,
  );
  for (const event of notable) {
    needsAttention.add(event.sessionKey);
    attentionTypes.set(event.sessionKey, event.classification as "blocked" | "turnComplete");
  }

  // Clear attention for the specific pane the user is focused on (not the whole window)
  if (activePaneId) {
    needsAttention.delete(activePaneId);
    attentionTypes.delete(activePaneId);
  }

  // Dispatch notifications only for sessions that still have attention
  const notableWithAttention = notable.filter((e) => needsAttention.has(e.sessionKey));
  if (notableWithAttention.length > 0) {
    await dispatchNotifications(notableWithAttention, config);
  }

  // Sync 🔄 running prefix on tmux window names.
  // Group sessions by window, compute desired prefix, rename if stale.
  const windowMap = new Map<string, { sessionName: string; windowIndex: number; windowName: string; hasAttention: boolean; hasRunning: boolean }>();
  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
    const existing = windowMap.get(wKey);
    if (existing) {
      if (needsAttention.has(session.tmuxPane.paneId)) existing.hasAttention = true;
      if (session.status === "running") existing.hasRunning = true;
    } else {
      windowMap.set(wKey, {
        sessionName: session.tmuxPane.sessionName,
        windowIndex: session.tmuxPane.windowIndex,
        windowName: session.tmuxPane.windowName,
        hasAttention: needsAttention.has(session.tmuxPane.paneId),
        hasRunning: session.status === "running",
      });
    }
  }
  for (const win of windowMap.values()) {
    const prefix = desiredPrefix(win.hasAttention, win.hasRunning);
    const baseName = stripAllPrefixes(win.windowName);
    const desired = `${prefix}${baseName}`;
    if (win.windowName !== desired) {
      await debugLog(`prefix-sync ${win.sessionName}:${win.windowIndex}: "${win.windowName}" → "${desired}"`);
      await renameWindow(win.sessionName, win.windowIndex, desired);
    }
  }

  // Save state — but first check if another process (csm next) modified state
  // since we loaded it. If so, don't overwrite their changes.
  const freshState = await loadState();
  if (freshState.lastUpdatedAt !== state.lastUpdatedAt) {
    await debugLog(`freshState bail: state modified by another process during poll`);
    const aggregate = computeAggregate(freshState);
    process.stdout.write(formatWidget(aggregate));
    return;
  }

  await debugLog(`saving: needsAttention={${[...needsAttention].join(", ")}}`);
  const sessionStates = buildSessionStates(sessions, needsAttention, attentionTypes, state.sessions);
  const newState = { lastUpdatedBy: "monitor" as const, lastUpdatedAt: Date.now(), sessions: sessionStates };
  await saveState(newState);

  // Output widget text to stdout — tmux renders this in the status bar
  const aggregate = computeAggregate(newState);
  process.stdout.write(formatWidget(aggregate));
}

main().catch(() => {
  // Never crash — just output nothing
});
