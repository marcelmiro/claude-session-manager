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
import { clearWindowAttentionPrefix, stripAllPrefixes, ATTENTION_PREFIX } from "./core/notifications";
import { findClaudeProcesses } from "./core/process";
import { detectStatus } from "./core/status";
import { loadNameCache } from "./core/names";

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
  try {
    const client = (await Bun.$`tmux list-clients -F '#{client_name}'`.quiet().text()).trim().split("\n")[0];
    if (client) {
      const activePaneId = (await Bun.$`tmux display-message -c ${client} -p '#{pane_id}'`.quiet().text()).trim();
      const activeSession = state.sessions[activePaneId];
      if (activePaneId && activeSession?.needsAttention) {
        activeSession.needsAttention = false;
        activeSession.attentionType = undefined;
        // Strip ⚡ from source window if no other panes in it still need attention
        if (activeSession.tmuxSession !== undefined && activeSession.tmuxWindow !== undefined) {
          const othersInSourceWindow = Object.values(state.sessions).some(
            (s) =>
              s.needsAttention &&
              s.tmuxPane !== activePaneId &&
              s.tmuxSession === activeSession.tmuxSession &&
              s.tmuxWindow === activeSession.tmuxWindow,
          );
          if (!othersInSourceWindow) {
            await clearWindowAttentionPrefix(activeSession.tmuxSession!, activeSession.tmuxWindow!);
          }
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
      // Session no longer needs attention — clear stale flag and ⚡ prefix
      s.needsAttention = false;
      s.attentionType = undefined;
      if (s.tmuxSession !== undefined && s.tmuxWindow !== undefined) {
        await clearWindowAttentionPrefix(s.tmuxSession!, s.tmuxWindow!);
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
    const attentionPanes = panes.filter((p) => p.windowName.startsWith(ATTENTION_PREFIX));

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
        // Not actually needing attention — strip the stale ⚡ prefix
        await clearWindowAttentionPrefix(pane.sessionName, pane.windowIndex);
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
  // Use lastUpdatedBy="tui" so the status widget defers to our state
  // and doesn't overwrite our changes on its next poll
  const stateEntry = state.sessions[target.paneId];
  if (stateEntry) {
    stateEntry.needsAttention = false;
    stateEntry.attentionType = undefined;
  }
  state.lastUpdatedBy = "tui";
  state.lastUpdatedAt = Date.now();
  await saveState(state);

  // Strip ⚡ from window name — but only if no other panes in this window still need attention.
  // Uses clearWindowAttentionPrefix which reads the actual tmux window name (not stale state).
  const othersInWindow = Object.values(state.sessions).some(
    (s) =>
      s.needsAttention &&
      s.tmuxSession === target!.tmuxSession &&
      s.tmuxWindow === target!.tmuxWindow,
  );
  if (!othersInWindow) {
    await clearWindowAttentionPrefix(target.tmuxSession, target.tmuxWindow);
  }

  // Switch to the pane
  await switchToPane(target.paneId, target.tmuxSession, target.tmuxWindow);

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

      const cleanName = stripAllPrefixes(name);

      if (cleanName === sessionName) {
        // Window name matches tmux session name → reset to "claude"
        await renameWindow(sessionName, parseInt(windowIndex, 10), "claude");
        count++;
      } else if (!KEEP_NAMES.has(cleanName)) {
        // AI-generated or unknown name → reset to "claude"
        await renameWindow(sessionName, parseInt(windowIndex, 10), "claude");
        count++;
      } else if (name !== cleanName) {
        // Standard name with prefix → just strip the prefix
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

      const name = stripAllPrefixes(pane.windowName);
      const repo = pane.currentPath.split("/").pop() || pane.currentPath;

      return {
        name,
        status: result.status,
        contextPercent: result.contextPercent,
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
      `${icon} ${s.name.padEnd(24)} ${s.status.padEnd(8)} ${s.repo}${ctx}${attention}`,
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

  const [panes, processes, nameCache] = await Promise.all([
    listPanes(),
    findClaudeProcesses({}),
    loadNameCache(),
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

  // Clear ⚡ if present (keep 🔄 — session may still be running)
  if (best.windowName.startsWith(ATTENTION_PREFIX)) {
    await renameWindow(
      best.sessionName,
      best.windowIndex,
      best.windowName.slice(ATTENTION_PREFIX.length),
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
