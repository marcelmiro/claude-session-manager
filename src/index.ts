import { createLayout } from "./ui/layout";
import { renderStatusBar } from "./ui/status-bar";
import { buildDisplayRows, renderSessionList, moveSelection, moveToGroup, getSelectableIndices } from "./ui/session-list";
import { updatePreview, getPreviewPlainText } from "./ui/preview-pane";
import { discoverSessions, groupSessions } from "./core/sessions";
import { switchToPane, getMainSession, killPane, renameWindow } from "./core/tmux";
import { loadNameCache, getSessionName, generateAIName, saveNameCache, enqueueAutoName, processAutoNameQueue, clearAutoNameFailure, type NameCache } from "./core/names";
import { loadConfig } from "./core/config";
import { loadState, saveState, buildSessionStates } from "./core/state";
import { detectTransitions, dispatchNotifications, clearWindowAttentionPrefix, stripAllPrefixes, desiredPrefix } from "./core/notifications";
import { discoverRepos, listBranches, checkoutBranch, trackAndCheckout, createWorktree } from "./core/git";
import { initWizard, renderWizard, renderWizardPreview, renderWizardStatusBar, handleWizardKey, worktreeDirName } from "./ui/wizard";
import { C } from "./ui/colors";
import type { DisplayRow, Session, CsmConfig, WizardState, WizardRepo } from "./types";
import type { SessionStatus } from "./core/status";
import { resolve } from "path";

// Guard: refuse to run without a proper terminal.
// Prevents orphaned background processes (e.g. from bun --watch after terminal closes)
// from continuously overwriting state.json with stale attention flags.
if (!process.stdout.isTTY) {
  process.exit(0);
}

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
let nameCache: NameCache = { version: 2, names: {}, sources: {} };
let notifConfig: CsmConfig = { statusWidget: true, windowPrefix: true, repoPaths: [] };

// Wizard state (null = not in wizard mode)
let wizardState: WizardState | null = null;
let wizardLaunching = false;
// Flag: true while keypress handler is processing a wizard key this tick.
// Prevents screen.key() handlers (which fire after keypress) from acting
// on a key the wizard already consumed (e.g. Escape = cancel, not quit).
let wizardHandledKey = false;

// Attention type tracking: what kind of transition triggered attention
const attentionTypes = new Map<string, "blocked" | "turnComplete">();

// Kill confirmation state
let pendingKillPaneId: string | null = null;
let killConfirmTimer: ReturnType<typeof setTimeout> | null = null;

// Attention tracking: detect running→input transitions
const previousStatuses = new Map<string, SessionStatus>();
const needsAttention = new Set<string>();

/** Check if other panes in the same window still need attention */
function otherPanesNeedAttention(session: Session, allSessions: Session[]): boolean {
  if (!session.tmuxPane) return false;
  const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
  return allSessions.some(s =>
    s.tmuxPane &&
    `${s.tmuxPane.sessionName}:${s.tmuxPane.windowIndex}` === wKey &&
    s.tmuxPane.paneId !== session.tmuxPane!.paneId &&
    needsAttention.has(s.tmuxPane.paneId),
  );
}

function updateStatusBar() {
  if (wizardState) return; // Don't overwrite wizard status bar
  if (flashTimer) return; // Don't overwrite active flash messages
  renderStatusBar(statusBar, getSelectedSession()?.status, showArchived);
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

async function refresh(opts?: { skipArchivedSummaries?: boolean; skipSessionIds?: boolean }) {
  if (isRefreshing) return;
  if (wizardState) return; // Don't overwrite wizard UI with session list
  isRefreshing = true;
  try {
    // Only pass nameMap (for window name reverse lookup) when lsof has had a
    // chance to run. On first render (skipSessionIds=true), lsof is skipped, so
    // claimedIds would be empty — wrong window names from previous bugs could
    // cause incorrect matches. After first render, lsof populates claimedIds,
    // preventing wrong window names from overriding correct lsof mappings.
    const { sessions, changedPaneIds } = await discoverSessions({
      ...opts,
      nameMap: opts?.skipSessionIds ? undefined : nameCache.names,
    });
    allSessions = sessions;

    // Reset stale state for panes where session ID changed (e.g. after /clear)
    if (changedPaneIds.size > 0) {
      for (const session of sessions) {
        if (session.tmuxPane && changedPaneIds.has(session.tmuxPane.paneId)) {
          renameWindow(session.tmuxPane.sessionName, session.tmuxPane.windowIndex, "claude");
          previousStatuses.delete(session.tmuxPane.paneId);
          needsAttention.delete(session.tmuxPane.paneId);
          attentionTypes.delete(session.tmuxPane.paneId);
        }
      }
    }

    // Assign names from cache (AI-generated only, no heuristic fallback)
    for (const session of sessions) {
      session.name = getSessionName(session.id, nameCache);
    }

    // Sync tmux window names — group by window to handle multi-pane windows
    const windowSessions = new Map<string, Session[]>();
    for (const session of sessions) {
      if (!session.tmuxPane) continue;
      const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
      const list = windowSessions.get(wKey);
      if (list) list.push(session);
      else windowSessions.set(wKey, [session]);
    }

    for (const [_, windowGroup] of windowSessions) {
      const first = windowGroup[0].tmuxPane!;
      const hasAttention = windowGroup.some(s => s.tmuxPane && needsAttention.has(s.tmuxPane.paneId));
      const hasRunning = windowGroup.some(s => s.status === "running");
      const prefix = desiredPrefix(hasAttention, hasRunning);

      let targetBase: string | undefined;
      if (windowGroup.length === 1) {
        // Single Claude pane: sync AI name
        const session = windowGroup[0];
        if (session.name) targetBase = session.name;
      } else {
        // Multi-pane window: use "claude/{repo}" if same repo, else "claude"
        const repos = new Set(windowGroup.map(s => s.repo));
        targetBase = repos.size === 1 ? `claude/${[...repos][0]}` : "claude";
      }

      if (targetBase) {
        const desired = `${prefix}${targetBase}`;
        if (first.windowName !== desired) {
          renameWindow(first.sessionName, first.windowIndex, desired);
        }
      } else {
        // No AI name yet — still sync prefix on existing base name
        const baseName = stripAllPrefixes(first.windowName);
        const desired = `${prefix}${baseName}`;
        if (first.windowName !== desired) {
          renameWindow(first.sessionName, first.windowIndex, desired);
        }
      }
    }

    // Enqueue active sessions for auto AI naming
    for (const session of sessions) {
      if (session.id && session.tmuxPane && session.status !== "archived") {
        enqueueAutoName(session.id, session.firstPrompt, session.summary, nameCache);
      }
    }
    processAutoNameQueue(nameCache);

    const groups = groupSessions(sessions, notifConfig.priorityRepos ?? []);

    // Detect transitions and update attention tracking
    const transitions = detectTransitions(previousStatuses, sessions);

    const currentKeys = new Set<string>();
    for (const session of sessions) {
      const key = session.tmuxPane?.paneId ?? session.id;
      currentKeys.add(key);
      previousStatuses.set(key, session.status);

      // Clear stale attention: if session went back to running, user already interacted
      if (session.status === "running" && needsAttention.has(key)) {
        needsAttention.delete(key);
        attentionTypes.delete(key);
        if (session.tmuxPane && !otherPanesNeedAttention(session, sessions)) {
          clearWindowAttentionPrefix(session.tmuxPane.sessionName, session.tmuxPane.windowIndex);
        }
      }
    }

    // Mark attention from transitions (track new keys so file sync doesn't clobber them)
    const newAttentionKeys = new Set<string>();
    for (const event of transitions) {
      if (event.classification !== "none") {
        needsAttention.add(event.sessionKey);
        attentionTypes.set(event.sessionKey, event.classification);
        newAttentionKeys.add(event.sessionKey);
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

    // Dispatch notifications (Tier 2 window ⚡ prefix)
    if (transitions.some((e) => e.classification !== "none")) {
      await dispatchNotifications(
        transitions.filter((e) => e.classification !== "none"),
        notifConfig,
      );
    }

    // Sync with external state changes before saving.
    // If csm-next or the status widget cleared attention for a session,
    // respect that clearing instead of blindly overwriting with our in-memory set.
    // This prevents stale/orphaned TUI processes from re-adding cleared attention.
    // Skip keys added THIS cycle — their old file state is stale, not an external clear.
    const fileState = await loadState();
    for (const [key, s] of Object.entries(fileState.sessions)) {
      if (!s.needsAttention && needsAttention.has(key) && !newAttentionKeys.has(key)) {
        needsAttention.delete(key);
        attentionTypes.delete(key);
      }
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
    if (session.tmuxPane && !otherPanesNeedAttention(session, allSessions)) {
      clearWindowAttentionPrefix(session.tmuxPane.sessionName, session.tmuxPane.windowIndex);
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
    needsAttention.delete(key);
    attentionTypes.delete(key);
    if (session.tmuxPane && !otherPanesNeedAttention(session, allSessions)) {
      clearWindowAttentionPrefix(session.tmuxPane.sessionName, session.tmuxPane.windowIndex);
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
  // Only clear ⚡ window prefix if no other panes in this window still need attention
  if (!otherPanesNeedAttention(session, allSessions)) {
    await clearWindowAttentionPrefix(sessionName, windowIndex);
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

// Key bindings (guarded: no-op when wizard is active)
screen.key(["j", "down"], () => { if (wizardState) return; handleSelect(1); });
screen.key(["k", "up"], () => { if (wizardState) return; handleSelect(-1); });
screen.key(["S-j"], () => { if (wizardState) return; handleGroupSelect(1); });
screen.key(["S-k"], () => { if (wizardState) return; handleGroupSelect(-1); });
screen.key(["enter"], () => { if (wizardState || wizardHandledKey) return; handleEnterContextual(); });
screen.key(["r"], () => { if (wizardState) return; refresh(); });
screen.key(["x"], () => { if (wizardState) return; handleKill(); });
screen.key(["f"], () => { if (wizardState) return; handleFork(); });
screen.key(["c"], async () => {
  if (wizardState) return;
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
  if (wizardState) return;
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
  clearAutoNameFailure(session.id);
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
  if (wizardState) return;
  showArchived = !showArchived;
  refresh();
});
screen.key(["y"], async () => {
  if (wizardState) return;
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
  if (wizardState) return;
  previewBox.scroll(-6);
  screen.render();
});
screen.key(["d"], () => {
  if (wizardState) return;
  previewBox.scroll(6);
  screen.render();
});
screen.key(["q"], () => {
  if (wizardState || wizardHandledKey) return;
  cleanup();
  process.exit(0);
});
screen.key(["escape"], () => {
  if (wizardState || wizardHandledKey) return;
  cleanup();
  process.exit(0);
});

// New Session wizard (`n` key)
screen.key(["n"], async () => {
  if (wizardState) return;

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
      const progressMsg = action.worktreeName
        ? `Creating worktree {${C.fg}-fg}${action.worktreeName}{/${C.fg}-fg}…`
        : action.branch.isCurrent ? "Launching…" : `Checking out {${C.fg}-fg}${action.branch.name}{/${C.fg}-fg}…`;
      statusBar.setContent(`  {${C.muted}-fg}${progressMsg}{/${C.muted}-fg}`);
      screen.render();
      const error = await handleWizardLaunch(action.repo, action.branch, action.worktreeName);
      wizardLaunching = false;
      if (error) {
        // Git/tmux error — keep wizard open so user can retry.
        // Re-render wizard form but NOT the status bar — let the flash message show the error.
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

/** Handle wizard launch: checkout/worktree + open new tmux window with claude.
 *  Returns null on success (exits process), or error string on failure. */
async function handleWizardLaunch(
  repo: WizardRepo,
  branch: { name: string; isRemote: boolean; isCurrent: boolean },
  worktreeName: string,
): Promise<string | null> {
  let targetDir = repo.path;

  if (worktreeName) {
    const wtPath = worktreeDirName(repo.name, worktreeName);
    const wtAbsPath = resolve(repo.path, wtPath);
    const result = await createWorktree(repo.path, wtAbsPath, worktreeName, branch.name, branch.isRemote);
    if (!result.ok) {
      return result.error ?? "Worktree creation failed";
    }
    targetDir = wtAbsPath;
  } else if (!branch.isCurrent) {
    // Need to checkout a different branch
    let result: { ok: boolean; error?: string };
    if (branch.isRemote) {
      result = await trackAndCheckout(repo.path, branch.name);
    } else {
      result = await checkoutBranch(repo.path, branch.name);
    }
    if (!result.ok) {
      return result.error ?? "Checkout failed";
    }
  }

  const targetSession = await getMainSession();
  if (!targetSession) {
    return "No tmux session found";
  }

  wizardState = null;
  cleanup();
  try {
    // Create window with a shell (so exiting claude doesn't close the window),
    // then send the claude command via send-keys
    const paneId = (await Bun.$`tmux new-window -t ${targetSession} -n "claude" -c ${targetDir} -P -F '#{pane_id}'`.quiet().text()).trim();
    if (paneId) {
      await Bun.$`tmux send-keys -t ${paneId} claude Enter`.quiet();
    }
  } catch {
    // ignore
  }
  process.exit(0);
}

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
