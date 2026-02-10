/**
 * CSM Status Widget — lightweight poll for tmux status-right.
 *
 * Called by tmux every `status-interval` seconds (e.g. 5s).
 * Detects session transitions, fires notifications, outputs widget text to stdout.
 * Replaces the background monitor daemon — tmux IS the scheduler.
 */

import { listPanes, capturePane } from "./core/tmux";
import { findClaudeProcesses } from "./core/process";
import { detectStatus, type SessionStatus } from "./core/status";
import { loadConfig } from "./core/config";
import { loadState, saveState, computeAggregate, buildSessionStates } from "./core/state";
import { detectTransitions, dispatchNotifications, clearWindowAttentionPrefix } from "./core/notifications";
import type { Session, AggregateStatus } from "./types";

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
        branch: "",
        status: result.status,
        contextPercent: result.contextPercent ?? 0,
        messageCount: 0,
        summary: "",
        modified: new Date(),
        firstPrompt: "",
        name: pane.windowName.replace(/^⚡/, ""),
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
  if (aggregate.needsAttention > 0) parts.push(`⚡${aggregate.needsAttention}`);
  if (aggregate.running > 0) parts.push(`🔄${aggregate.running}`);
  return parts.join(" ");
}

async function main(): Promise<void> {
  const [config, state] = await Promise.all([loadConfig(), loadState()]);

  // If TUI updated state recently, just output from its data — don't re-poll
  const tuiRecent = state.lastUpdatedBy === "tui" && (Date.now() - state.lastUpdatedAt) < 10_000;
  if (tuiRecent) {
    const aggregate = computeAggregate(state);
    process.stdout.write(formatWidget(aggregate));
    return;
  }

  // Quick poll active sessions
  const sessions = await quickDiscoverActive();

  // Rebuild previous statuses from saved state
  const previousStatuses = new Map<string, SessionStatus>();
  for (const [key, s] of Object.entries(state.sessions)) {
    previousStatuses.set(key, s.status as SessionStatus);
  }

  // Detect transitions
  const transitions = detectTransitions(previousStatuses, sessions);

  // Carry over existing attention flags from state
  const needsAttention = new Set<string>();
  const attentionTypes = new Map<string, "blocked" | "turnComplete">();
  for (const [key, s] of Object.entries(state.sessions)) {
    if (s.needsAttention) {
      needsAttention.add(key);
      if (s.attentionType) attentionTypes.set(key, s.attentionType);
    }
  }

  // Add new attention from transitions
  const notable = transitions.filter((e) => e.classification !== "none");
  for (const event of notable) {
    needsAttention.add(event.sessionKey);
    attentionTypes.set(event.sessionKey, event.classification as "blocked" | "turnComplete");
  }

  // Clean attention for panes that no longer exist
  const activePanes = new Set(sessions.map((s) => s.tmuxPane!.paneId));
  for (const key of needsAttention) {
    if (!activePanes.has(key)) {
      needsAttention.delete(key);
      attentionTypes.delete(key);
    }
  }

  // Auto-clear attention when user is focused on an attention pane.
  // Must use client-targeted display-message because #() status-right commands
  // don't have an implicit client context.
  try {
    const client = (await Bun.$`tmux list-clients -F #{client_name}`.quiet().text()).trim().split("\n")[0];
    if (client) {
      const activePane = (await Bun.$`tmux display-message -c ${client} -p #{pane_id}`.quiet().text()).trim();
      if (needsAttention.has(activePane)) {
        needsAttention.delete(activePane);
        attentionTypes.delete(activePane);
        const session = sessions.find((s) => s.tmuxPane?.paneId === activePane);
        if (session?.tmuxPane) {
          await clearWindowAttentionPrefix(session.tmuxPane.sessionName, session.tmuxPane.windowIndex);
        }
      }
    }
  } catch {
    // Not in tmux context
  }

  // Dispatch notifications for transitions
  if (notable.length > 0) {
    await dispatchNotifications(notable, config);
  }

  // Save state
  const sessionStates = buildSessionStates(sessions, needsAttention, attentionTypes);
  const newState = { lastUpdatedBy: "monitor" as const, lastUpdatedAt: Date.now(), sessions: sessionStates };
  await saveState(newState);

  // Output widget text to stdout — tmux renders this in the status bar
  const aggregate = computeAggregate(newState);
  process.stdout.write(formatWidget(aggregate));
}

main().catch(() => {
  // Never crash — just output nothing
});
