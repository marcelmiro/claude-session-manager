import { createLayout } from "./ui/layout";
import { renderStatusBar } from "./ui/status-bar";
import { buildDisplayRows, renderSessionList, moveSelection, moveToGroup, getSelectableIndices, filterDisplayRows } from "./ui/session-list";
import { handleTextInputKey, renderTextWithCursor } from "./ui/text-input";
import { updatePreview, getPreviewPlainText } from "./ui/preview-pane";
import { discoverSessions, groupSessions, seedPaneSessionCache } from "./core/sessions";
import { switchToPane, getMainSession, killPane } from "./core/tmux";
import { loadNameCache, getSessionName, generateAIName, saveNameCache, type NameCache } from "./core/names";
import { loadConfig } from "./core/config";
import { loadState, saveState, loadPaneSessions } from "./core/state";
import { syncWindowPrefix, buildBaseName } from "./core/notifications";
import { discoverRepos, listBranches } from "./core/git";
import { initWizard, renderWizard, renderWizardPreview, renderWizardStatusBar, handleWizardKey, worktreeDirName } from "./ui/wizard";
import { C } from "./ui/colors";
import type { DisplayRow, Session, CsmConfig, WizardState, WizardRepo } from "./types";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";

// Guard: refuse to run without a proper terminal.
// Prevents orphaned background processes (e.g. from bun --watch after terminal closes)
// from continuously overwriting state.json with stale attention flags.
if (!process.stdout.isTTY) {
  process.exit(0);
}

const focusPaneId = process.env.CSM_FOCUS_PANE?.match(/^%\d+$/)
  ? process.env.CSM_FOCUS_PANE
  : null;

const { screen, listBox, previewBox, statusBar } = createLayout();

let rows: DisplayRow[] = [];
let allSessions: Session[] = [];
let selectedIndex = -1;
let cachedSession: Session | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let isRefreshing = false;
let previewGeneration = 0;
let showArchived = false;
let nameCache: NameCache = { version: 3, names: {}, sources: {} };
let notifConfig: CsmConfig = { statusMonitor: true, windowPrefix: true, nativeNotification: true, repoPaths: [] };

// Wizard state (null = not in wizard mode)
let wizardState: WizardState | null = null;
let wizardLaunching = false;
// Flag: true while keypress handler is processing a wizard key this tick.
// Prevents screen.key() handlers (which fire after keypress) from acting
// on a key the wizard already consumed (e.g. Escape = cancel, not quit).
let wizardHandledKey = false;

// Search mode state
let searchActive = false;
let searchFilter = "";
let searchCursor = 0;
let unfilteredRows: DisplayRow[] = [];
let preSearchIndex = -1; // selection before search started

// Attention type tracking: what kind of transition triggered attention
const attentionTypes = new Map<string, "blocked" | "turnComplete">();

// Kill confirmation state
let pendingKillPaneId: string | null = null;
let killConfirmTimer: ReturnType<typeof setTimeout> | null = null;

// Attention state — populated from monitor's state.json each refresh
const needsAttention = new Set<string>();
// Persists across refreshes. Entries cleaned up when monitor clears the attention.
const localDismissals = new Set<string>();

/** Get attention + running flags for OTHER panes in the same window */
function getWindowFlags(session: Session, sessions: Session[]): { hasAttention: boolean; hasRunning: boolean } {
  if (!session.tmuxPane) return { hasAttention: false, hasRunning: false };
  const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
  let hasAttention = false;
  let hasRunning = false;
  for (const s of sessions) {
    if (!s.tmuxPane) continue;
    if (`${s.tmuxPane.sessionName}:${s.tmuxPane.windowIndex}` !== wKey) continue;
    if (s.tmuxPane.paneId === session.tmuxPane.paneId) continue;
    if (needsAttention.has(s.tmuxPane.paneId)) hasAttention = true;
    if (s.status === "running") hasRunning = true;
  }
  return { hasAttention, hasRunning };
}

function updateStatusBar() {
  if (wizardState) return; // Don't overwrite wizard status bar
  if (searchActive) return; // Don't overwrite search bar
  if (flashTimer) return; // Don't overwrite active flash messages
  renderStatusBar(statusBar, getSelectedSession()?.status, showArchived);
}

function renderSearchBar() {
  const text = renderTextWithCursor(searchFilter, searchCursor);
  statusBar.setContent(
    `{${C.peach}-fg}/{/${C.peach}-fg} ${text}` +
    `  {${C.dim}-fg}↑/↓ move  ⏎ select  Esc cancel{/${C.dim}-fg}`,
  );
}

function applySearchFilter() {
  rows = filterDisplayRows(unfilteredRows, searchFilter);
  const selectable = getSelectableIndices(rows);
  if (selectable.length > 0) {
    // Clamp selection to first match
    if (!selectable.includes(selectedIndex)) {
      selectedIndex = selectable[0];
    }
  } else {
    selectedIndex = -1;
  }
  saveSelection();
}

function exitSearch(restoreSelection: boolean) {
  searchActive = false;
  searchFilter = "";
  searchCursor = 0;
  rows = unfilteredRows;
  unfilteredRows = [];
  if (restoreSelection) {
    selectedIndex = preSearchIndex;
    // Clamp to valid range
    const selectable = getSelectableIndices(rows);
    if (selectable.length > 0 && !selectable.includes(selectedIndex)) {
      selectedIndex = selectable[0];
    }
  }
  saveSelection();
  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
  screen.render();
}

function flashStatusMessage(msg: string, duration = 2000) {
  if (flashTimer) clearTimeout(flashTimer);
  statusBar.setContent(`  ${msg}`);
  screen.render();
  flashTimer = setTimeout(() => {
    flashTimer = null;
    updateStatusBar();
    screen.render();
  }, duration);
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

async function refresh(opts?: { skipArchivedSummaries?: boolean }) {
  if (isRefreshing) return;
  if (wizardState) return; // Don't overwrite wizard UI with session list
  isRefreshing = true;
  try {
    const { sessions, changedPaneIds } = await discoverSessions({
      ...opts,
      nameMap: nameCache.names,
    });
    allSessions = sessions;

    // Reset stale state for panes where session ID changed (e.g. after /clear)
    if (changedPaneIds.size > 0) {
      for (const session of sessions) {
        if (session.tmuxPane && changedPaneIds.has(session.tmuxPane.paneId)) {
          needsAttention.delete(session.tmuxPane.paneId);
          attentionTypes.delete(session.tmuxPane.paneId);
        }
      }
    }

    // Reload name cache from disk (monitor may have generated new names)
    nameCache = await loadNameCache();

    // Assign names from cache (AI-generated only, no heuristic fallback)
    for (const session of sessions) {
      session.name = getSessionName(session.id, nameCache);
    }

    const groups = groupSessions(sessions, notifConfig.priorityRepos ?? []);

    // Read attention from monitor's state.json
    const monitorState = await loadState();
    needsAttention.clear();
    attentionTypes.clear();
    for (const [key, s] of Object.entries(monitorState.sessions)) {
      if (s.needsAttention && !localDismissals.has(key)) {
        needsAttention.add(key);
        if (s.attentionType) attentionTypes.set(key, s.attentionType);
      }
    }
    // Clean up dismissed entries the monitor already cleared
    for (const key of localDismissals) {
      if (!monitorState.sessions[key]?.needsAttention) {
        localDismissals.delete(key);
      }
    }

    if (groups.length === 0) {
      // Empty state — exit search if active
      if (searchActive) {
        searchActive = false;
        searchFilter = "";
        searchCursor = 0;
        unfilteredRows = [];
      }
      listBox.setContent(
        `\n\n\n{center}{${C.muted}-fg}No active sessions{/${C.muted}-fg}{/center}\n\n{center}{${C.dim}-fg}Start one with: claude{/${C.dim}-fg}{/center}`,
      );
      previewBox.setContent("");
      rows = [];
      selectedIndex = -1;
      screen.render();
      return;
    }

    const builtRows = buildDisplayRows(groups, showArchived);

    // When search is active, update unfiltered + reapply filter
    if (searchActive) {
      unfilteredRows = builtRows;
      rows = filterDisplayRows(unfilteredRows, searchFilter);
    } else {
      rows = builtRows;
    }

    const selectable = getSelectableIndices(rows);

    if (selectable.length === 0) {
      selectedIndex = searchActive ? -1 : -1;
      cachedSession = null;
    } else if (searchActive) {
      // During search, clamp to first selectable if current is invalid
      if (!selectable.includes(selectedIndex)) {
        selectedIndex = selectable[0];
      }
      saveSelection();
    } else if (selectedIndex < 0) {
      // First load — pre-select focused pane if provided, else first session
      if (focusPaneId) {
        const found = selectable.find((idx) => {
          const row = rows[idx];
          return row.type === "session" && row.session.tmuxPane?.paneId === focusPaneId;
        });
        selectedIndex = found ?? selectable[0];
      } else {
        selectedIndex = selectable[0];
      }
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
    if (searchActive) {
      renderSearchBar();
    } else {
      updateStatusBar();
    }
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

  // Dismiss attention for newly selected session (visual only, monitor clears within 5s)
  const session = getSelectedSession();
  if (session) {
    const key = session.tmuxPane?.paneId ?? session.id;
    if (needsAttention.has(key)) {
      localDismissals.add(key);
      needsAttention.delete(key);
      attentionTypes.delete(key);
    }
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
    if (needsAttention.has(key)) {
      localDismissals.add(key);
      needsAttention.delete(key);
      attentionTypes.delete(key);
    }
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
  const key = paneId;
  needsAttention.delete(key);
  attentionTypes.delete(key);

  // Immediate ⚡ clear — don't wait 5s for monitor
  const flags = getWindowFlags(session, allSessions);
  await syncWindowPrefix(sessionName, windowIndex,
    flags.hasAttention, session.status === "running" || flags.hasRunning);

  // Clear attention in state.json (fresh read to avoid overwriting monitor data)
  const freshState = await loadState();
  if (freshState.sessions[key]) {
    freshState.sessions[key].needsAttention = false;
    freshState.sessions[key].attentionType = undefined;
    freshState.lastUpdatedAt = Date.now();
    await saveState(freshState);
  }

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

  const repoName = session.repoPath.split("/").filter(Boolean).pop() ?? "claude";
  cleanup();
  try {
    const cmd = `claude --resume=${session.id}; exec zsh -l`;
    await Bun.$`tmux new-window -a -t ${targetSession} -n ${repoName} -c ${session.repoPath} zsh -c ${cmd}`.quiet();
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

  const repoName = session.repoPath.split("/").filter(Boolean).pop() ?? "claude";
  const forkName = buildBaseName(repoName, session.name || undefined, true);

  cleanup();
  try {
    const cmd = `claude --resume=${session.id} --fork-session; exec zsh -l`;
    await Bun.$`tmux new-window -a -t ${targetSession} -n ${forkName} -c ${session.repoPath} zsh -c ${cmd}`.quiet();
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

// Key bindings (guarded: no-op when wizard or search is active)
screen.key(["j", "down"], () => { if (wizardState || searchActive) return; handleSelect(1); });
screen.key(["k", "up"], () => { if (wizardState || searchActive) return; handleSelect(-1); });
screen.key(["S-j"], () => { if (wizardState || searchActive) return; handleGroupSelect(1); });
screen.key(["S-k"], () => { if (wizardState || searchActive) return; handleGroupSelect(-1); });
screen.key(["enter"], () => { if (wizardState || wizardHandledKey || searchActive) return; handleEnterContextual(); });
screen.key(["r"], () => { if (wizardState || searchActive) return; refresh(); });
screen.key(["x"], () => { if (wizardState || searchActive) return; handleKill(); });
screen.key(["f"], () => { if (wizardState || searchActive) return; handleFork(); });
screen.key(["c"], async () => {
  if (wizardState || searchActive) return;
  const session = getSelectedSession();
  if (!session?.repoPath) {
    flashStatusMessage(`{${C.dim}-fg}No repo path{/${C.dim}-fg}`);
    return;
  }
  try {
    await Bun.$`open -a Cursor ${session.repoPath}`.quiet();
    flashStatusMessage(`{${C.mint}-fg}Opened in Cursor{/${C.mint}-fg}`);
  } catch {
    flashStatusMessage(`{${C.red}-fg}Failed to open Cursor{/${C.red}-fg}`);
  }
});
screen.key(["s"], () => {
  if (wizardState || searchActive) return;
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
  const sessionSummary = session.summary;
  const sessionFirstPrompt = session.firstPrompt;
  generateAIName(sessionFirstPrompt, sessionSummary).then(async (name) => {
    if (name) {
      nameCache.names[sessionId] = name;
      nameCache.sources[sessionId] = sessionSummary || sessionFirstPrompt;
      await saveNameCache(nameCache);
      await refresh();
    } else {
      flashStatusMessage(`{${C.dim}-fg}Name generation failed{/${C.dim}-fg}`);
    }
  });
});
screen.key(["a"], () => {
  if (wizardState || searchActive) return;
  showArchived = !showArchived;
  refresh();
});
screen.key(["y"], async () => {
  if (wizardState || searchActive) return;
  const text = getPreviewPlainText();
  if (!text) {
    flashStatusMessage(`{${C.dim}-fg}Nothing to copy{/${C.dim}-fg}`);
    return;
  }
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    proc.stdin.write(text);
    proc.stdin.end();
    await proc.exited;
    flashStatusMessage(`{${C.mint}-fg}Copied to clipboard{/${C.mint}-fg}`);
  } catch {
    flashStatusMessage(`{${C.red}-fg}Copy failed{/${C.red}-fg}`);
  }
});
screen.key(["u"], () => {
  if (wizardState || searchActive) return;
  previewBox.scroll(-6);
  screen.render();
});
screen.key(["d"], () => {
  if (wizardState || searchActive) return;
  previewBox.scroll(6);
  screen.render();
});
screen.key(["q"], () => {
  if (wizardState || wizardHandledKey || searchActive) return;
  cleanup();
  process.exit(0);
});
screen.key(["escape"], () => {
  if (wizardState || wizardHandledKey || searchActive) return;
  cleanup();
  process.exit(0);
});

// New Session wizard (`n` key)
screen.key(["n"], async () => {
  if (wizardState || searchActive) return;

  // Pause refresh loop
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }

  // Collect repos from display rows
  const sessionRepos = getUniqueRepos(rows);

  // Discover repos (merge session repos + config paths)
  const repos = await discoverRepos(sessionRepos, notifConfig.repoPaths ?? [], notifConfig.priorityRepos ?? []);

  if (repos.length === 0) {
    flashStatusMessage(`{${C.dim}-fg}No repos found{/${C.dim}-fg}`);
    refreshTimer = setInterval(refresh, 3000);
    return;
  }

  // Preselect repo from current selection
  const selectedRow = getSelectedRow();
  let preselectedRepoPath: string | undefined;
  if (selectedRow?.type === "repo-header") {
    preselectedRepoPath = selectedRow.path;
  } else if (selectedRow?.type === "session") {
    preselectedRepoPath = selectedRow.session.baseRepoPath;
  }

  wizardState = initWizard(repos, preselectedRepoPath);

  if (!wizardState) {
    flashStatusMessage(`{${C.dim}-fg}No repos found{/${C.dim}-fg}`);
    refreshTimer = setInterval(refresh, 3000);
    return;
  }

  // If auto-skipped to branch step, load branches
  if (wizardState.step === "branch" && wizardState.selectedRepo) {
    const branches = await listBranches(wizardState.selectedRepo.path);
    wizardState.branches = branches;
    wizardState.filteredBranches = branches;
  }

  renderWizard(listBox, wizardState);
  renderWizardStatusBar(statusBar, wizardState);
  await renderWizardPreview(previewBox, wizardState);
  screen.render();
});

// Flag: true during the tick when `/` activates search, prevents the search
// keypress handler from also processing `/` as text input in the same event.
let searchJustActivated = false;

// `/` key activates search mode
screen.on("keypress", (_ch: string, key: any) => {
  if (!key || wizardState || searchActive) return;
  if (_ch === "/" && !key.ctrl && !key.meta) {
    searchActive = true;
    searchFilter = "";
    searchCursor = 0;
    preSearchIndex = selectedIndex;
    unfilteredRows = [...rows];
    searchJustActivated = true;
    queueMicrotask(() => { searchJustActivated = false; });
    renderSearchBar();
    screen.render();
  }
});

// Search keypress handler (intercepts all keys when search is active)
screen.on("keypress", async (_ch: string, key: any) => {
  if (!searchActive || !key || searchJustActivated) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  if (keyName === "escape") {
    exitSearch(true);
    return;
  }

  if (keyName === "enter" || keyName === "return") {
    const row = getSelectedRow();
    if (row?.type === "archive-collapsed") {
      // Expand archives: exit search and show all
      exitSearch(false);
      showArchived = true;
      await refresh();
      return;
    }
    const session = getSelectedSession();
    if (session) {
      // Exit search, keep filtered selection, then switch/resume
      searchActive = false;
      searchFilter = "";
      searchCursor = 0;
      rows = unfilteredRows;
      unfilteredRows = [];

      if (session.status === "archived") {
        await handleResume();
      } else {
        await handleEnter();
      }
    }
    return;
  }

  if (keyName === "up") {
    if (rows.length > 0) {
      selectedIndex = moveSelection(rows, selectedIndex, -1);
      saveSelection();
      renderSessionList(listBox, rows, selectedIndex, needsAttention);
      const selectedRow = getSelectedRow();
      const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
      await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
      screen.render();
    }
    return;
  }

  if (keyName === "down") {
    if (rows.length > 0) {
      selectedIndex = moveSelection(rows, selectedIndex, 1);
      saveSelection();
      renderSessionList(listBox, rows, selectedIndex, needsAttention);
      const selectedRow = getSelectedRow();
      const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
      await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
      screen.render();
    }
    return;
  }

  // All other keys go to text input
  const result = handleTextInputKey(searchFilter, searchCursor, keyName, ch);
  if (result.handled) {
    const changed = result.text !== searchFilter;
    searchFilter = result.text;
    searchCursor = result.cursor;
    if (changed) {
      applySearchFilter();
      renderSessionList(listBox, rows, selectedIndex, needsAttention);
      const selectedRow = getSelectedRow();
      const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
      await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
    }
    renderSearchBar();
    screen.render();
  }
});

// Wizard keypress handler (intercepts all keys when wizard is active)
screen.on("keypress", async (_ch: string, key: any) => {
  if (!wizardState || !key) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  const action = handleWizardKey(wizardState, keyName, ch);
  if (action.type !== "noop") {
    wizardHandledKey = true;
    queueMicrotask(() => { wizardHandledKey = false; });
  }

  switch (action.type) {
    case "noop":
      break;
    case "render":
      renderWizard(listBox, wizardState);
      renderWizardStatusBar(statusBar, wizardState);
      await renderWizardPreview(previewBox, wizardState);
      screen.render();
      break;
    case "preview":
      renderWizard(listBox, wizardState);
      renderWizardStatusBar(statusBar, wizardState);
      await renderWizardPreview(previewBox, wizardState);
      screen.render();
      break;
    case "cancel":
      wizardState = null;
      refreshTimer = setInterval(refresh, 3000);
      await refresh();
      break;
    case "quit":
      cleanup();
      process.exit(0);
    case "loadBranches": {
      const branches = await listBranches(wizardState.selectedRepo!.path);
      wizardState.branches = branches;
      wizardState.filteredBranches = branches;
      renderWizard(listBox, wizardState);
      renderWizardStatusBar(statusBar, wizardState);
      await renderWizardPreview(previewBox, wizardState);
      screen.render();
      break;
    }
    case "launch": {
      if (wizardLaunching) break;
      wizardLaunching = true;
      statusBar.setContent(`  {${C.muted}-fg}Launching…{/${C.muted}-fg}`);
      screen.render();
      const error = await handleWizardLaunch(action.repo, action.branch, action.worktreeName);
      wizardLaunching = false;
      if (error) {
        // Only reachable if tmux session lookup fails
        renderWizard(listBox, wizardState!);
        screen.render();
        flashStatusMessage(`{${C.red}-fg}${error}{/${C.red}-fg}`, 4000);
      }
      break;
    }
  }
});

/** Extract unique repos from display rows */
function getUniqueRepos(displayRows: DisplayRow[]): Array<{ name: string; path: string }> {
  const seen = new Map<string, { name: string; path: string }>();
  for (const row of displayRows) {
    if (row.type === "repo-header" && !seen.has(row.path)) {
      seen.set(row.path, { name: row.name, path: row.path });
    }
  }
  return [...seen.values()];
}

/** Handle wizard launch: create tmux window immediately, run git + claude inside it.
 *  Returns null on success (exits process), or error string on failure. */
async function handleWizardLaunch(
  repo: WizardRepo,
  branch: { name: string; isRemote: boolean; isCurrent: boolean },
  worktreeName: string,
): Promise<string | null> {
  const targetSession = await getMainSession();
  if (!targetSession) {
    return "No tmux session found";
  }

  wizardState = null;
  cleanup();
  try {
    // Build compound command: git operations (if needed) then claude
    let cmd: string;
    if (worktreeName) {
      const wtPath = worktreeDirName(repo.name, worktreeName);
      const wtAbsPath = resolve(repo.path, wtPath);
      const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
      cmd = `git worktree add ${shellQuote(wtAbsPath)} -b ${shellQuote(worktreeName)} ${shellQuote(baseRef)} 2>/dev/null || git worktree add ${shellQuote(wtAbsPath)} ${shellQuote(worktreeName)} && cd ${shellQuote(wtAbsPath)} && claude`;
    } else if (!branch.isCurrent) {
      const checkout = branch.isRemote
        ? `git checkout -b ${shellQuote(branch.name)} --track origin/${shellQuote(branch.name)} 2>/dev/null || git checkout ${shellQuote(branch.name)}`
        : `git checkout ${shellQuote(branch.name)}`;
      cmd = `${checkout} && claude`;
    } else {
      cmd = "claude";
    }

    if (cmd === "claude") {
      // Simple case: launch claude directly as the window command (no shell race)
      await Bun.$`tmux new-window -a -t ${targetSession} -n ${repo.name} -c ${repo.path} claude`.quiet();
    } else {
      // Compound command: run via zsh -c to avoid send-keys race with shell init
      // (oh-my-zsh prompts can swallow keystrokes). exec zsh -l keeps shell open after claude exits.
      const wrapped = `${cmd}; exec zsh -l`;
      await Bun.$`tmux new-window -a -t ${targetSession} -n ${repo.name} -c ${repo.path} zsh -c ${wrapped}`.quiet();
    }
  } catch {
    // ignore — window may already exist
  }
  process.exit(0);
}

/** Shell-quote a string for safe embedding in tmux send-keys commands. */
function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Render loading state immediately so the TUI appears instantly
listBox.setContent(
  `\n\n\n{center}{${C.muted}-fg}Loading sessions…{/${C.muted}-fg}{/center}`,
);
updateStatusBar();
screen.render();

// Load name cache + notification config + pane sessions, then start refresh loop
Promise.all([loadNameCache(), loadConfig(), loadPaneSessions()]).then(([cache, config, paneSessions]) => {
  nameCache = cache;
  notifConfig = config;
  // Seed pane→sessionId cache from disk (persisted by monitor)
  seedPaneSessionCache(paneSessions);
  // Nudge: flash a message if the SessionStart hook is missing or outdated
  const hookPath = `${homedir()}/.config/csm/hooks/session-start.sh`;
  let needsSetup = !existsSync(hookPath);
  if (!needsSetup) {
    try {
      const content = readFileSync(hookPath, "utf-8");
      needsSetup = !content.includes("CSM_HOOK_VERSION=");
    } catch { needsSetup = true; }
  }
  if (needsSetup) {
    setTimeout(() => flashStatusMessage(`{${C.muted}-fg}Run {${C.peach}-fg}csm setup{/${C.peach}-fg} for auto session naming{/${C.muted}-fg}`, 5000), 500);
  }
  // Initial load: skip archived summaries for instant render.
  // The 3s auto-refresh will fill in summaries and context %.
  refresh({ skipArchivedSummaries: true });
  refreshTimer = setInterval(refresh, 3000);
});
