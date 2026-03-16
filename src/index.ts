import { createLayout } from "./ui/layout";
import { renderStatusBar } from "./ui/status-bar";
import { buildDisplayRows, renderSessionList, moveSelection, moveToGroup, getSelectableIndices } from "./ui/session-list";
import { handleTextInputKey, renderTextWithCursor } from "./ui/text-input";
import { updatePreview, getPreviewPlainText, renderMessage } from "./ui/preview-pane";
import { discoverSessions, groupSessions, seedPaneSessionCache } from "./core/sessions";
import { readPreviewMessages } from "./core/jsonl-reader";
import { switchToPane, getMainSession, killPane } from "./core/tmux";
import { loadNameCache, getSessionName, generateAIName, saveNameCache, type NameCache } from "./core/names";
import { loadConfig } from "./core/config";
import { loadState, saveState, loadPaneSessions } from "./core/state";
import { syncWindowPrefix, buildBaseName } from "./core/notifications";
import { discoverRepos, listBranches } from "./core/git";
import { initWizard, renderWizard, renderWizardPreview, renderWizardStatusBar, handleWizardKey, worktreeDirName } from "./ui/wizard";
import { loadAllSessions, filterAndRankEntries, type SearchEntry } from "./core/search";
import { renderSearchResults } from "./ui/search-list";
import { C } from "./ui/colors";
import type { DisplayRow, Session, CsmConfig, WizardState, WizardRepo, GlobalSearchState } from "./types";
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

// Global search state (null = not in search mode)
let globalSearch: GlobalSearchState | null = null;
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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
  if (globalSearch) return; // Don't overwrite search bar
  if (flashTimer) return; // Don't overwrite active flash messages
  renderStatusBar(statusBar, getSelectedSession()?.status, showArchived);
}

function renderSearchBar() {
  if (!globalSearch) return;
  const text = renderTextWithCursor(globalSearch.query, globalSearch.cursor);
  const countStr = globalSearch.loading
    ? "loading…"
    : `${globalSearch.results.length} result${globalSearch.results.length === 1 ? "" : "s"}`;
  statusBar.setContent(
    `{${C.peach}-fg}/{/${C.peach}-fg} ${text}` +
    `  {${C.dim}-fg}${countStr}  ↑/↓ move  ⏎ switch/resume  Esc cancel{/${C.dim}-fg}`,
  );
}

function applySearchFilter() {
  if (!globalSearch) return;
  globalSearch.results = filterAndRankEntries(globalSearch.entries, globalSearch.query);
  if (globalSearch.results.length > 0) {
    globalSearch.selectedIndex = Math.min(globalSearch.selectedIndex, globalSearch.results.length - 1);
  } else {
    globalSearch.selectedIndex = 0;
  }
}

async function exitSearch() {
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  globalSearch = null;
  selectedIndex = preSearchIndex;
  // Clamp to valid range
  const selectable = getSelectableIndices(rows);
  if (selectable.length > 0 && !selectable.includes(selectedIndex)) {
    selectedIndex = selectable[0];
  }
  saveSelection();
  renderSessionList(listBox, rows, selectedIndex, needsAttention);
  updateStatusBar();
  // Restore preview for the selected session
  const selectedRow = getSelectedRow();
  const archivedSessions = selectedRow?.type === "archive-collapsed" ? selectedRow.sessions : undefined;
  await safeUpdatePreview(cachedSession, { scrollToBottom: true, archivedSessions });
  screen.render();
}

/** Get the currently selected search entry (if in search mode) */
function getSelectedSearchEntry(): SearchEntry | null {
  if (!globalSearch || globalSearch.results.length === 0) return null;
  return globalSearch.results[globalSearch.selectedIndex] ?? null;
}

/** Update preview pane for a search result, with staleness guard */
async function updateSearchPreview(entry: SearchEntry | null): Promise<void> {
  if (!entry) {
    previewBox.setContent("");
    return;
  }

  // For active sessions, reuse the existing preview pipeline
  if (entry.isActive) {
    const activeSession = allSessions.find((s) => s.id === entry.sessionId);
    if (activeSession) {
      await safeUpdatePreview(activeSession, { scrollToBottom: true });
      return;
    }
  }

  // Staleness guard — if selection changed while reading JSONL, discard
  const gen = ++previewGeneration;

  // Header: repo/branch · summary
  const boxWidth = typeof previewBox.width === "number" ? previewBox.width : 40;
  const contentWidth = Math.max(10, boxWidth - 4);
  const repoHeader = `${entry.repo}/${entry.branch}`;
  let header = `{${C.muted}-fg}  ${repoHeader}{/${C.muted}-fg}`;
  if (entry.summary) {
    const escaped = entry.summary.replace(/\{/g, "{open}").replace(/\}/g, "{close}").replace(/\n/g, " ");
    const maxLen = Math.max(10, boxWidth - repoHeader.length - 5);
    const trunc = escaped.length > maxLen ? escaped.slice(0, maxLen - 1) + "\u2026" : escaped;
    header += ` {${C.dim}-fg}\u00b7{/${C.dim}-fg} {${C.muted}-fg}${trunc}{/${C.muted}-fg}`;
  }

  // Read messages from JSONL, reusing shared rendering from preview-pane
  let body = "";
  if (entry.fullPath) {
    try {
      const messages = await readPreviewMessages(entry.fullPath, 3);
      if (gen !== previewGeneration) return; // stale
      if (messages.length > 0) {
        body = messages.map((msg) => renderMessage(msg, contentWidth)).join("\n\n");
      }
    } catch {}
  }

  if (!body && entry.firstPrompt) {
    const escaped = entry.firstPrompt.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
    body = `{${C.muted}-fg}${escaped}{/${C.muted}-fg}`;
  }

  if (!body) {
    body = `{${C.dim}-fg}No recent output{/${C.dim}-fg}`;
  }

  if (gen !== previewGeneration) return; // stale
  previewBox.setContent(`${header}\n\n${body}`);
  previewBox.setScrollPerc(100);
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
  if (globalSearch) return; // Don't overwrite search UI
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
screen.key(["j", "down"], () => { if (wizardState || globalSearch) return; handleSelect(1); });
screen.key(["k", "up"], () => { if (wizardState || globalSearch) return; handleSelect(-1); });
screen.key(["S-j"], () => { if (wizardState || globalSearch) return; handleGroupSelect(1); });
screen.key(["S-k"], () => { if (wizardState || globalSearch) return; handleGroupSelect(-1); });
screen.key(["enter"], () => { if (wizardState || wizardHandledKey || globalSearch) return; handleEnterContextual(); });
screen.key(["r"], () => { if (wizardState || globalSearch) return; refresh(); });
screen.key(["x"], () => { if (wizardState || globalSearch) return; handleKill(); });
screen.key(["f"], () => { if (wizardState || globalSearch) return; handleFork(); });
screen.key(["c"], async () => {
  if (wizardState || globalSearch) return;
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
  if (wizardState || globalSearch) return;
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
  if (wizardState || globalSearch) return;
  showArchived = !showArchived;
  refresh();
});
screen.key(["y"], async () => {
  if (wizardState || globalSearch) return;
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
  if (wizardState || globalSearch) return;
  previewBox.scroll(-6);
  screen.render();
});
screen.key(["d"], () => {
  if (wizardState || globalSearch) return;
  previewBox.scroll(6);
  screen.render();
});
screen.key(["q"], () => {
  if (wizardState || wizardHandledKey || globalSearch) return;
  cleanup();
  process.exit(0);
});
screen.key(["escape"], () => {
  if (wizardState || wizardHandledKey || globalSearch) return;
  cleanup();
  process.exit(0);
});

// Quick new session in selected repo (`N` / Shift+N)
screen.key(["S-n"], async () => {
  if (wizardState || globalSearch) return;

  const session = getSelectedSession();
  if (!session?.repoPath) {
    flashStatusMessage(`{${C.dim}-fg}No repo selected{/${C.dim}-fg}`);
    return;
  }

  const repoPath = session.repoPath;
  const repoName = repoPath.split("/").pop() || "repo";

  // Get current branch
  let currentBranch = "main";
  try {
    currentBranch = (await Bun.$`git -C ${repoPath} branch --show-current`.quiet().text()).trim() || "main";
  } catch {}

  const repo: WizardRepo = { name: repoName, path: repoPath, currentBranch };
  const branch = { name: currentBranch, isRemote: false, isCurrent: true };

  flashStatusMessage(`{${C.muted}-fg}Launching in ${repoName}…{/${C.muted}-fg}`);
  const error = await handleWizardLaunch(repo, branch, "");
  if (error) {
    flashStatusMessage(`{${C.red}-fg}${error}{/${C.red}-fg}`, 4000);
  }
});

// New Session wizard (`n` key)
screen.key(["n"], async () => {
  if (wizardState || globalSearch) return;

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

// `/` key activates global search mode
screen.on("keypress", (_ch: string, key: any) => {
  if (!key || wizardState || globalSearch) return;
  if (_ch === "/" && !key.ctrl && !key.meta) {
    preSearchIndex = selectedIndex;
    globalSearch = {
      query: "",
      cursor: 0,
      entries: [],
      results: [],
      selectedIndex: 0,
      loading: true,
    };
    searchJustActivated = true;
    queueMicrotask(() => { searchJustActivated = false; });

    // Show loading state
    listBox.setContent(
      `\n\n\n{center}{${C.muted}-fg}Loading sessions…{/${C.muted}-fg}{/center}`,
    );
    renderSearchBar();
    screen.render();

    // Load all sessions asynchronously
    loadAllSessions(nameCache, allSessions).then((entries) => {
      if (!globalSearch) return; // exited search while loading
      globalSearch.entries = entries;
      globalSearch.loading = false;
      globalSearch.results = filterAndRankEntries(entries, globalSearch.query);
      renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
      renderSearchBar();
      // Update preview for first result
      updateSearchPreview(getSelectedSearchEntry());
      screen.render();
    });
  }
});

/** Handle search result selection: switch to active or resume archived */
async function handleSearchEnter() {
  const entry = getSelectedSearchEntry();
  if (!entry) return;

  if (entry.isActive && entry.activePaneId && entry.activeSessionName != null && entry.activeWindowIndex != null) {
    const paneId = entry.activePaneId;
    const sessionName = entry.activeSessionName;
    const windowIndex = entry.activeWindowIndex;

    // Clear attention for this pane
    needsAttention.delete(paneId);
    attentionTypes.delete(paneId);

    // Find matching session to sync window prefix
    const session = allSessions.find((s) => s.id === entry.sessionId);
    if (session) {
      const flags = getWindowFlags(session, allSessions);
      await syncWindowPrefix(sessionName, windowIndex,
        flags.hasAttention, session.status === "running" || flags.hasRunning);
    }

    // Clear attention in state.json
    const freshState = await loadState();
    if (freshState.sessions[paneId]) {
      freshState.sessions[paneId].needsAttention = false;
      freshState.sessions[paneId].attentionType = undefined;
      freshState.lastUpdatedAt = Date.now();
      await saveState(freshState);
    }

    globalSearch = null;
    cleanup();
    await switchToPane(paneId, sessionName, windowIndex);
    process.exit(0);
    return;
  }

  // Archived session: resume in new tmux window
  const targetSession = await getMainSession();
  if (!targetSession) return;

  // Determine directory: use base repo if worktree is deleted
  const effectivePath = entry.isDeletedWorktree ? entry.baseRepoPath : entry.projectPath;
  const repoName = entry.repo;

  globalSearch = null;
  cleanup();
  try {
    const cmd = `claude --resume=${entry.sessionId}; exec zsh -l`;
    await Bun.$`tmux new-window -a -t ${targetSession} -n ${repoName} -c ${effectivePath} zsh -c ${cmd}`.quiet();
  } catch {
    // ignore
  }
  process.exit(0);
}

// Search keypress handler (intercepts all keys when search is active)
screen.on("keypress", async (_ch: string, key: any) => {
  if (!globalSearch || !key || searchJustActivated) return;

  const keyName = key.full || key.name || "";
  const ch = _ch || "";

  if (keyName === "escape") {
    exitSearch();
    return;
  }

  if (keyName === "enter" || keyName === "return") {
    await handleSearchEnter();
    return;
  }

  if (keyName === "up") {
    if (globalSearch.results.length > 0) {
      globalSearch.selectedIndex = Math.max(0, globalSearch.selectedIndex - 1);
      renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
      await updateSearchPreview(getSelectedSearchEntry());
      screen.render();
    }
    return;
  }

  if (keyName === "down") {
    if (globalSearch.results.length > 0) {
      globalSearch.selectedIndex = Math.min(globalSearch.results.length - 1, globalSearch.selectedIndex + 1);
      renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
      await updateSearchPreview(getSelectedSearchEntry());
      screen.render();
    }
    return;
  }

  // All other keys go to text input
  const result = handleTextInputKey(globalSearch.query, globalSearch.cursor, keyName, ch);
  if (result.handled) {
    const changed = result.text !== globalSearch.query;
    globalSearch.query = result.text;
    globalSearch.cursor = result.cursor;
    if (changed) {
      // Debounce filter/rank
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        if (!globalSearch) return;
        applySearchFilter();
        renderSearchResults(listBox, globalSearch.results, globalSearch.selectedIndex);
        updateSearchPreview(getSelectedSearchEntry());
        screen.render();
      }, 100);
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
