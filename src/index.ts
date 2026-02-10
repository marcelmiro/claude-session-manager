import { createLayout } from "./ui/layout";
import { renderStatusBar } from "./ui/status-bar";
import { buildDisplayRows, renderSessionList, moveSelection, moveToGroup, getSelectableIndices } from "./ui/session-list";
import { updatePreview } from "./ui/preview-pane";
import { discoverSessions, groupSessions } from "./core/sessions";
import { switchToPane, getMainSession, killPane, renameWindow } from "./core/tmux";
import { loadNameCache, getSessionName, generateAIName, saveNameCache, type NameCache } from "./core/names";
import { loadConfig } from "./core/config";
import { saveState, buildSessionStates } from "./core/state";
import { detectTransitions, dispatchNotifications, clearWindowAttentionPrefix } from "./core/notifications";
import { C } from "./ui/colors";
import type { DisplayRow, Session, NotificationConfig } from "./types";
import type { SessionStatus } from "./core/status";

const { screen, listBox, previewBox, statusBar } = createLayout();

let rows: DisplayRow[] = [];
let selectedIndex = -1;
let cachedSession: Session | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let isRefreshing = false;
let previewGeneration = 0;
let showArchived = false;
let nameCache: NameCache = { version: 1, names: {} };
let notifConfig: NotificationConfig = { statusWidget: true, windowPrefix: true, bell: true, bellOn: "all" };

// Attention type tracking: what kind of transition triggered attention
const attentionTypes = new Map<string, "blocked" | "turnComplete">();

// Kill confirmation state
let pendingKillPaneId: string | null = null;
let killConfirmTimer: ReturnType<typeof setTimeout> | null = null;

// Attention tracking: detect running→input transitions
const previousStatuses = new Map<string, SessionStatus>();
const needsAttention = new Set<string>();

function updateStatusBar() {
  renderStatusBar(statusBar, getSelectedSession()?.status, showArchived);
}

function flashStatusMessage(msg: string) {
  if (flashTimer) clearTimeout(flashTimer);
  statusBar.setContent(`  ${msg}`);
  screen.render();
  flashTimer = setTimeout(() => {
    updateStatusBar();
    screen.render();
  }, 2000);
}

function getSelectedRow(): DisplayRow | null {
  if (selectedIndex < 0 || selectedIndex >= rows.length) return null;
  return rows[selectedIndex];
}

function getSelectedSession() {
  const row = getSelectedRow();
  if (!row) return null;
  return row.type === "session" ? row.session : null;
}

function saveSelection() {
  cachedSession = getSelectedSession();
}

/** Update preview with staleness guard. Returns true if the result is still current. */
async function safeUpdatePreview(
  session: ReturnType<typeof getSelectedSession>,
  opts?: { scrollToBottom?: boolean; archivedSessions?: Session[] },
): Promise<boolean> {
  const gen = ++previewGeneration;
  await updatePreview(previewBox, session, opts);
  return gen === previewGeneration;
}

async function refresh(opts?: { skipArchivedSummaries?: boolean; skipSessionIds?: boolean }) {
  if (isRefreshing) return;
  isRefreshing = true;
  try {
    const sessions = await discoverSessions(opts);

    // Assign names from cache or programmatic generation
    for (const session of sessions) {
      session.name = getSessionName(session.id, session.firstPrompt, session.summary, nameCache);

      // Rename tmux windows still named "claude" to the AI-generated name
      if (session.name && session.tmuxPane?.windowName === "claude") {
        const { sessionName, windowIndex } = session.tmuxPane;
        renameWindow(sessionName, windowIndex, session.name);
      }
    }

    const groups = groupSessions(sessions);

    // Detect transitions and update attention tracking
    const transitions = detectTransitions(previousStatuses, sessions);

    const currentKeys = new Set<string>();
    for (const session of sessions) {
      const key = session.tmuxPane?.paneId ?? session.id;
      currentKeys.add(key);
      previousStatuses.set(key, session.status);
    }

    // Mark attention from transitions
    for (const event of transitions) {
      if (event.classification !== "none") {
        needsAttention.add(event.sessionKey);
        attentionTypes.set(event.sessionKey, event.classification);
      }
    }

    // Clean up stale keys
    for (const key of previousStatuses.keys()) {
      if (!currentKeys.has(key)) {
        previousStatuses.delete(key);
        needsAttention.delete(key);
        attentionTypes.delete(key);
      }
    }

    // Dispatch notifications (Tier 2 window prefix + Tier 3 bell)
    if (transitions.some((e) => e.classification !== "none")) {
      await dispatchNotifications(
        transitions.filter((e) => e.classification !== "none"),
        notifConfig,
      );
    }

    // Write shared state (async, non-blocking) — csm-status reads this
    const sessionStates = buildSessionStates(sessions, needsAttention, attentionTypes);
    const sharedState = { lastUpdatedBy: "tui" as const, lastUpdatedAt: Date.now(), sessions: sessionStates };
    saveState(sharedState);

    if (groups.length === 0) {
      // Empty state
      listBox.setContent(
        `\n\n\n{center}{${C.muted}-fg}No active sessions{/${C.muted}-fg}{/center}\n\n{center}{${C.dim}-fg}Start one with: claude{/${C.dim}-fg}{/center}`,
      );
      previewBox.setContent("");
      rows = [];
      selectedIndex = -1;
      screen.render();
      return;
    }

    rows = buildDisplayRows(groups, showArchived);
    const selectable = getSelectableIndices(rows);

    if (selectable.length === 0) {
      selectedIndex = -1;
      cachedSession = null;
    } else if (selectedIndex < 0) {
      // First load
      selectedIndex = selectable[0];
      saveSelection();
    } else {
      // Try to keep cursor on the same session across refreshes
      const paneId = cachedSession?.tmuxPane?.paneId;
      const sessionId = cachedSession?.id;

      if (paneId) {
        // Active session: match by paneId (most reliable)
        const found = selectable.find((idx) => {
          const row = rows[idx];
          return row.type === "session" && row.session.tmuxPane?.paneId === paneId;
        });
        if (found !== undefined) {
          selectedIndex = found;
        }
        // If pane not found in rows, keep selectedIndex as-is — pane still exists in tmux
      } else if (sessionId) {
        // Archived session: match by session ID (stable across reorders)
        const found = selectable.find((idx) => {
          const row = rows[idx];
          return row.type === "session" && row.session.id === sessionId;
        });
        if (found !== undefined) {
          selectedIndex = found;
        } else if (!selectable.includes(selectedIndex)) {
          selectedIndex = selectable.reduce((best, idx) =>
            Math.abs(idx - selectedIndex) < Math.abs(best - selectedIndex) ? idx : best,
          );
        }
      } else if (!selectable.includes(selectedIndex)) {
        // No identifier to match — clamp to nearest selectable
        selectedIndex = selectable.reduce((best, idx) =>
          Math.abs(idx - selectedIndex) < Math.abs(best - selectedIndex) ? idx : best,
        );
      }

      // Keep cachedSession in sync with the actual selected row
      saveSelection();
    }

    const isInitial = !refreshTimer;
    renderSessionList(listBox, rows, selectedIndex, needsAttention);
    updateStatusBar();
    const selectedRow = getSelectedRow();
    const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
    const isCurrent = await safeUpdatePreview(cachedSession, { scrollToBottom: isInitial, archivedSessions });
    if (isCurrent) screen.render();
  } finally {
    isRefreshing = false;
  }
}

async function handleSelect(direction: 1 | -1) {
  if (rows.length === 0) return;
  selectedIndex = moveSelection(rows, selectedIndex, direction);
  saveSelection();

  // Clear attention for newly selected session
  const session = getSelectedSession();
  if (session) {
    const key = session.tmuxPane?.paneId ?? session.id;
    needsAttention.delete(key);
    attentionTypes.delete(key);
  }

  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
  const selectedRow = getSelectedRow();
  const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
  const isCurrent = await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
  if (isCurrent) screen.render();
}

async function handleGroupSelect(direction: 1 | -1) {
  if (rows.length === 0) return;
  selectedIndex = moveToGroup(rows, selectedIndex, direction);
  saveSelection();

  const session = getSelectedSession();
  if (session) {
    const key = session.tmuxPane?.paneId ?? session.id;
    needsAttention.delete(key);
    attentionTypes.delete(key);
  }

  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
  const selectedRow = getSelectedRow();
  const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
  const isCurrent = await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
  if (isCurrent) screen.render();
}

async function handleEnter() {
  const session = getSelectedSession();
  if (!session?.tmuxPane) return;

  const { paneId, sessionName, windowIndex } = session.tmuxPane;
  // Clear ⚡ window prefix before switching
  await clearWindowAttentionPrefix(sessionName, windowIndex);
  cleanup();
  await switchToPane(paneId, sessionName, windowIndex);
  process.exit(0);
}

async function handleResume() {
  const session = getSelectedSession();
  if (!session) return;
  if (!session.id) return;

  const targetSession = await getMainSession();
  if (!targetSession) return;

  cleanup();
  try {
    await Bun.$`tmux new-window -t ${targetSession} -n "claude" ${"claude --resume " + session.id}`.quiet();
  } catch {
    // ignore
  }
  process.exit(0);
}

/** Contextual Enter: switch to active sessions, resume archived sessions, expand collapsed archives */
async function handleEnterContextual() {
  const row = getSelectedRow();
  if (!row) return;

  if (row.type === "archive-collapsed") {
    showArchived = true;
    await refresh();
    return;
  }

  const session = getSelectedSession();
  if (!session) return;

  if (session.status === "archived") {
    await handleResume();
  } else {
    await handleEnter();
  }
}

/** Kill handler with double-press confirmation */
async function handleKill() {
  const session = getSelectedSession();
  if (!session) return;

  if (!session.tmuxPane) {
    flashStatusMessage(`{${C.dim}-fg}Can only kill active sessions{/${C.dim}-fg}`);
    return;
  }

  const paneId = session.tmuxPane.paneId;

  if (pendingKillPaneId === paneId) {
    // Second press — confirmed
    if (killConfirmTimer) clearTimeout(killConfirmTimer);
    pendingKillPaneId = null;
    await killPane(paneId);
    flashStatusMessage(`{${C.mint}-fg}Session killed{/${C.mint}-fg}`);
    await refresh();
    return;
  }

  // First press — ask for confirmation
  pendingKillPaneId = paneId;
  flashStatusMessage(`{${C.red}-fg}Kill session? Press x again to confirm{/${C.red}-fg}`);
  if (killConfirmTimer) clearTimeout(killConfirmTimer);
  killConfirmTimer = setTimeout(() => {
    pendingKillPaneId = null;
    updateStatusBar();
    screen.render();
  }, 3000);
}

/** Fork handler: resume --fork in a new tmux window */
async function handleFork() {
  const session = getSelectedSession();
  if (!session) return;

  if (!session.id) {
    flashStatusMessage(`{${C.dim}-fg}No session ID to fork{/${C.dim}-fg}`);
    return;
  }

  const targetSession = await getMainSession();
  if (!targetSession) return;

  cleanup();
  try {
    await Bun.$`tmux new-window -t ${targetSession} -n "claude" ${"claude --resume " + session.id + " --fork"}`.quiet();
  } catch {
    // ignore
  }
  process.exit(0);
}

function cleanup() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (killConfirmTimer) clearTimeout(killConfirmTimer);
  screen.destroy();
}

// Key bindings
screen.key(["j", "down"], () => handleSelect(1));
screen.key(["k", "up"], () => handleSelect(-1));
screen.key(["S-j"], () => handleGroupSelect(1));
screen.key(["S-k"], () => handleGroupSelect(-1));
screen.key(["enter"], () => handleEnterContextual());
screen.key(["r"], () => refresh());
screen.key(["x"], () => handleKill());
screen.key(["f"], () => handleFork());
screen.key(["s"], () => {
  const session = getSelectedSession();
  if (!session || !session.firstPrompt) {
    flashStatusMessage(`{${C.dim}-fg}No prompt to generate name from{/${C.dim}-fg}`);
    return;
  }
  if (session.status === "archived") {
    flashStatusMessage(`{${C.dim}-fg}AI naming disabled for archived sessions{/${C.dim}-fg}`);
    return;
  }
  flashStatusMessage(`{${C.muted}-fg}Generating name…{/${C.muted}-fg}`);
  const sessionId = session.id;
  const pane = session.tmuxPane;
  generateAIName(session.firstPrompt, session.summary).then(async (name) => {
    if (name) {
      nameCache.names[sessionId] = name;
      await saveNameCache(nameCache);
      if (pane?.windowName === "claude") {
        await renameWindow(pane.sessionName, pane.windowIndex, name);
      }
      await refresh();
    } else {
      flashStatusMessage(`{${C.dim}-fg}Name generation failed{/${C.dim}-fg}`);
    }
  });
});
screen.key(["a"], () => {
  showArchived = !showArchived;
  refresh();
});
screen.key(["u"], () => {
  previewBox.scroll(-3);
  screen.render();
});
screen.key(["d"], () => {
  previewBox.scroll(3);
  screen.render();
});
screen.key(["q", "escape"], () => {
  cleanup();
  process.exit(0);
});

// Render loading state immediately so the TUI appears instantly
listBox.setContent(
  `\n\n\n{center}{${C.muted}-fg}Loading sessions…{/${C.muted}-fg}{/center}`,
);
updateStatusBar();
screen.render();

// Load name cache + notification config, then start refresh loop
Promise.all([loadNameCache(), loadConfig()]).then(([cache, config]) => {
  nameCache = cache;
  notifConfig = config;
  // Initial load: skip lsof (1-3s cold) and archived summaries for instant render.
  // The 3s auto-refresh will fill in session IDs, summaries, and context %.
  refresh({ skipArchivedSummaries: true, skipSessionIds: true });
  refreshTimer = setInterval(refresh, 3000);
});
