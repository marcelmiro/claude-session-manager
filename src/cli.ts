/**
 * CSM CLI subcommands — lightweight commands that don't require the full TUI.
 *
 * csm next          — switch to the next session needing attention
 * csm reset         — reset all window names back to "claude"
 * csm list          — print a text-only session list
 * csm switch <name> — fuzzy-match a session by name and switch to it
 */

import { loadState, saveState } from "./core/state";
import { switchToPane, listPanes, renameWindow, capturePane, displayMessage } from "./core/tmux";
import { findClaudeProcesses } from "./core/process";
import { detectStatus } from "./core/status";

// ---------------------------------------------------------------------------
// csm next
// ---------------------------------------------------------------------------

/**
 * Switch to the next session needing attention.
 * Picks the session that has been waiting the longest (oldest lastTransition).
 */
export async function next(): Promise<void> {
  const state = await loadState();

  const attentionSessions = Object.entries(state.sessions)
    .filter(([_, s]) => s.needsAttention)
    .sort(
      (a, b) => (a[1].lastTransition ?? Infinity) - (b[1].lastTransition ?? Infinity),
    );

  if (attentionSessions.length === 0) {
    await displayMessage("No sessions need attention");
    return;
  }

  const [_, session] = attentionSessions[0];

  if (!session.tmuxSession || session.tmuxWindow === undefined || !session.tmuxPane) {
    await displayMessage("Session missing tmux info");
    return;
  }

  // Clear attention flag and save
  session.needsAttention = false;
  session.attentionType = undefined;
  state.lastUpdatedAt = Date.now();
  await saveState(state);

  // Strip ⚡ from window name
  if (session.windowName?.startsWith("⚡")) {
    await renameWindow(
      session.tmuxSession,
      session.tmuxWindow,
      session.windowName.slice("⚡".length),
    );
  }

  // Switch to the pane
  await switchToPane(session.tmuxPane, session.tmuxSession, session.tmuxWindow);

  // Jump itself is the confirmation — no toast needed.
}

// ---------------------------------------------------------------------------
// csm reset
// ---------------------------------------------------------------------------

/** Standard shell/tool names that shouldn't be renamed. */
const KEEP_NAMES = new Set(["claude", "zsh", "bash", "dev", "fish", "sh"]);

/**
 * Reset all tmux window names back to "claude".
 * Strips ⚡ prefixes and AI-generated names. Also clears attention state.
 */
export async function reset(): Promise<void> {
  try {
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

      const cleanName = name.replace(/^⚡/, "");

      if (cleanName === sessionName) {
        // Window name matches tmux session name → reset to "claude"
        await renameWindow(sessionName, parseInt(windowIndex, 10), "claude");
        count++;
      } else if (!KEEP_NAMES.has(cleanName)) {
        // AI-generated or unknown name → reset to "claude"
        await renameWindow(sessionName, parseInt(windowIndex, 10), "claude");
        count++;
      } else if (name.startsWith("⚡")) {
        // Standard name with ⚡ prefix → just strip the prefix
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
  const [panes, processes] = await Promise.all([
    listPanes(),
    findClaudeProcesses({ skipSessionIds: true }),
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

  // Capture and detect status for each pane
  const sessions = await Promise.all(
    claudePanes.map(async (pane) => {
      const captured = await capturePane(pane.paneId);
      const plain = captured
        .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
      const result = detectStatus(plain, true);

      const name = pane.windowName.replace(/^⚡/, "");
      const repo = pane.currentPath.split("/").pop() || pane.currentPath;

      return {
        name,
        status: result.status,
        contextPercent: result.contextPercent,
        repo,
        needsAttention: pane.windowName.startsWith("⚡"),
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
      `${icon} ${s.name.padEnd(24)} ${s.status.padEnd(8)} ${s.repo}${ctx}${attention}`,
    );
  }
}

// ---------------------------------------------------------------------------
// csm switch <name>
// ---------------------------------------------------------------------------

/**
 * Fuzzy-match a session by name and switch to it.
 */
export async function switchTo(name?: string): Promise<void> {
  if (!name) {
    console.error("Usage: csm switch <name>");
    process.exit(1);
  }

  const panes = await listPanes();
  const needle = name.toLowerCase();

  // Score each pane by name match quality
  const scored = panes
    .map((pane) => {
      const windowName = pane.windowName.replace(/^⚡/, "").toLowerCase();
      let score = 0;

      if (windowName === needle) score = 100;
      else if (windowName.startsWith(needle)) score = 80;
      else if (windowName.includes(needle)) score = 60;
      else {
        const words = windowName.split(/[-_\s]+/);
        if (words.some((w) => w.startsWith(needle))) score = 40;
        else if (isSubsequence(needle, windowName)) score = 20;
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

  // Clear ⚡ if present
  if (best.windowName.startsWith("⚡")) {
    await renameWindow(
      best.sessionName,
      best.windowIndex,
      best.windowName.slice("⚡".length),
    );
  }

  await switchToPane(best.paneId, best.sessionName, best.windowIndex);
}

function isSubsequence(sub: string, str: string): boolean {
  let j = 0;
  for (let i = 0; i < str.length && j < sub.length; i++) {
    if (str[i] === sub[j]) j++;
  }
  return j === sub.length;
}
