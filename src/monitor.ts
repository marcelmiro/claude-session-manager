/**
 * CSM Monitor — single state authority for tmux status-right.
 *
 * Called by tmux every `status-interval` seconds (e.g. 5s).
 * Phase 1 (fast, ~50ms): Detect transitions, manage attention, sync prefixes, output status.
 * Phase 2 (after stdout): Process hook events, detect /clear, generate AI names.
 */

import { listPanes, capturePane, renameWindow } from "./core/tmux";
import { findClaudeProcesses } from "./core/process";
import { detectStatus, type SessionStatus } from "./core/status";
import { loadConfig, PATHS } from "./core/config";
import { loadState, saveState, computeAggregate, buildSessionStates, loadPaneSessions, savePaneSessions, processHookEvents } from "./core/state";
import { detectTransitions, dispatchNotifications, syncWindowPrefix, ATTENTION_PREFIX, stripAllPrefixes, desiredPrefix } from "./core/notifications";
import { loadNameCache, saveNameCache, generateAIName, acquireNamingLock, releaseNamingLock, type NameCache } from "./core/names";
import { findActiveSessionInfo } from "./core/sessions";
import { homedir } from "os";
import type { Session, AggregateStatus, PaneInfo, ClaudeProcess } from "./types";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Naming skip tracking — persistent across monitor invocations
// ---------------------------------------------------------------------------

const NAMING_SKIP_PATH = `${homedir()}/.config/csm/naming-skip.json`;
const NAMING_SKIP_TTL = 5 * 60_000; // 5 minutes

type NamingSkipMap = Record<string, number>; // sessionId → timestamp

async function loadNamingSkips(): Promise<NamingSkipMap> {
  try {
    const raw = await Bun.file(NAMING_SKIP_PATH).text();
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveNamingSkips(skips: NamingSkipMap): Promise<void> {
  try {
    await Bun.write(NAMING_SKIP_PATH, JSON.stringify(skips));
  } catch {}
}

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
 * Returns sessions with their current status and all tmux panes.
 */
async function quickDiscoverActive(): Promise<{ sessions: Session[]; allPanes: PaneInfo[]; resumeIds: Record<string, string> }> {
  const [panes, processes] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
  ]);

  // Build TTY→process map (prefer processes with sessionId from --resume flag)
  const claudeTtyMap = new Map<string, ClaudeProcess>();
  for (const proc of processes) {
    const existing = claudeTtyMap.get(proc.tty);
    if (!existing || proc.sessionId) {
      claudeTtyMap.set(proc.tty, proc);
    }
  }

  // Find panes with Claude processes and collect --resume session IDs
  const claudePanes: PaneInfo[] = [];
  const resumeIds: Record<string, string> = {};
  for (const pane of panes) {
    const normalizedTty = pane.tty.replace(/^\/dev\//, "");
    const proc = claudeTtyMap.get(normalizedTty);
    if (proc) {
      claudePanes.push(pane);
      if (proc.sessionId) {
        resumeIds[pane.paneId] = proc.sessionId;
      }
    }
  }

  // Capture and detect status for each pane in parallel
  const sessions = await Promise.all(
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
  return { sessions, allPanes: panes, resumeIds };
}

function formatStatus(aggregate: AggregateStatus): string {
  const parts: string[] = [];
  if (aggregate.needsAttention > 0) parts.push(`⚡ ${aggregate.needsAttention}`);
  if (aggregate.running > 0) parts.push(`🔄 ${aggregate.running}`);
  return parts.join(" ");
}

async function main(): Promise<void> {
  const [config, state, paneSessionMap, nameCache] = await Promise.all([
    loadConfig(),
    loadState(),
    loadPaneSessions(),
    loadNameCache(),
  ]);

  // Auto-clear: sync prefix on the window the user is currently viewing.
  // Clears ⚡ for the focused pane but preserves 🔄 if other panes are running.
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

      // Sync prefix on active window — clear ⚡ for focused pane, preserve 🔄 for running panes
      if (activeWindowName?.startsWith(ATTENTION_PREFIX)) {
        const otherPanesHaveAttention = Object.values(state.sessions).some(
          (s) =>
            s.needsAttention &&
            s.tmuxPane !== activePaneId &&
            s.tmuxSession === activeSession &&
            String(s.tmuxWindow) === activeWindow,
        );
        const anyRunning = Object.values(state.sessions).some(
          (s) =>
            s.tmuxSession === activeSession &&
            String(s.tmuxWindow) === activeWindow &&
            s.status === "running",
        );
        await debugLog(`auto-clear ⚡ on active window ${activeSession}:${activeWindow} (${activeWindowName})`);
        await syncWindowPrefix(activeSession!, parseInt(activeWindow!, 10), otherPanesHaveAttention, anyRunning);
      }
    }
  } catch {
    // Not in tmux context
  }

  // Quick poll active sessions
  const { sessions, allPanes, resumeIds } = await quickDiscoverActive();
  await debugLog(`discovered ${sessions.length} sessions: ${sessions.map((s) => `${s.tmuxPane!.paneId}=${s.status}`).join(", ") || "(none)"}`);

  // Seed paneSessionMap with --resume IDs as fallbacks (don't overwrite hook events,
  // which are more authoritative — e.g. after /clear the process still has stale --resume <old-id>)
  for (const [paneId, sessionId] of Object.entries(resumeIds)) {
    if (!paneSessionMap[paneId]) {
      paneSessionMap[paneId] = sessionId;
    }
  }

  // Process hook events early (before prefix sync) so /clear renames happen in the same cycle.
  // This prevents the prefix sync from re-applying a stale AI name from the old session.
  const { changed: hookChanged, changedPaneIds: clearPaneIds } = await processHookEvents(paneSessionMap);
  if (hookChanged) {
    await debugLog(`hook events processed (early), changed panes: ${[...clearPaneIds].join(", ") || "(new only)"}`);
  }

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

  // Sync prefixes on tmux window names.
  // Group sessions by window, compute desired prefix + name-aware base name.
  const windowMap = new Map<string, { sessionName: string; windowIndex: number; windowName: string; hasAttention: boolean; hasRunning: boolean; paneIds: string[] }>();
  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
    const existing = windowMap.get(wKey);
    if (existing) {
      if (needsAttention.has(session.tmuxPane.paneId)) existing.hasAttention = true;
      if (session.status === "running") existing.hasRunning = true;
      existing.paneIds.push(session.tmuxPane.paneId);
    } else {
      windowMap.set(wKey, {
        sessionName: session.tmuxPane.sessionName,
        windowIndex: session.tmuxPane.windowIndex,
        windowName: session.tmuxPane.windowName,
        hasAttention: needsAttention.has(session.tmuxPane.paneId),
        hasRunning: session.status === "running",
        paneIds: [session.tmuxPane.paneId],
      });
    }
  }
  for (const win of windowMap.values()) {
    const prefix = desiredPrefix(win.hasAttention, win.hasRunning);
    let baseName = stripAllPrefixes(win.windowName);

    // If any pane in this window just had /clear, reset to "claude"
    const hasCleared = win.paneIds.some(id => clearPaneIds.has(id));
    if (hasCleared) {
      baseName = "claude";
    } else if (win.paneIds.length === 1) {
      // For single-pane windows, use AI name from cache if available
      const sessionId = paneSessionMap[win.paneIds[0]];
      if (sessionId && nameCache.names[sessionId]) {
        baseName = nameCache.names[sessionId];
      }
    } else {
      // Multi-pane window: "claude/{repo}" if same repo, else "claude"
      const repos = new Set(
        win.paneIds.map(id => {
          const s = sessions.find(s => s.tmuxPane?.paneId === id);
          return s ? s.repoPath.split("/").filter(Boolean).pop() ?? "unknown" : "unknown";
        })
      );
      baseName = repos.size === 1 ? `claude/${[...repos][0]}` : "claude";
    }

    const desired = `${prefix}${baseName}`;
    if (win.windowName !== desired) {
      await debugLog(`prefix-sync ${win.sessionName}:${win.windowIndex}: "${win.windowName}" → "${desired}"`);
      await renameWindow(win.sessionName, win.windowIndex, desired);
    }
  }

  // Strip stale ⚡/🔄 prefixes from windows that no longer have Claude sessions.
  // When a session exits, its window is invisible to the sync loop above.
  for (const pane of allPanes) {
    const wKey = `${pane.sessionName}:${pane.windowIndex}`;
    if (!windowMap.has(wKey) && pane.windowName !== stripAllPrefixes(pane.windowName)) {
      const baseName = stripAllPrefixes(pane.windowName);
      await debugLog(`stale-prefix ${pane.sessionName}:${pane.windowIndex}: "${pane.windowName}" → "${baseName}"`);
      await renameWindow(pane.sessionName, pane.windowIndex, baseName);
    }
  }

  // Save state — but first check if another process (csm next) modified state
  // since we loaded it. If so, don't overwrite their changes.
  const freshState = await loadState();
  if (freshState.lastUpdatedAt !== state.lastUpdatedAt) {
    await debugLog(`freshState bail: state modified by another process during poll`);
    const aggregate = computeAggregate(freshState);
    process.stdout.write(formatStatus(aggregate));
    // Still run Phase 2 (lsof + naming) — it writes to separate files
    phase2(sessions, paneSessionMap, nameCache, hookChanged).catch(() => {});
    return;
  }

  await debugLog(`saving: needsAttention={${[...needsAttention].join(", ")}}`);
  const sessionStates = buildSessionStates(sessions, needsAttention, attentionTypes, state.sessions);
  const newState = { lastUpdatedBy: "monitor" as const, lastUpdatedAt: Date.now(), sessions: sessionStates };
  await saveState(newState);

  // Output status text to stdout — tmux renders this in the status bar
  const aggregate = computeAggregate(newState);
  process.stdout.write(formatStatus(aggregate));

  // Phase 2: hook events + AI naming (runs after stdout, doesn't block tmux)
  phase2(sessions, paneSessionMap, nameCache, hookChanged).catch(() => {});
}

/**
 * Phase 2 — runs after stdout output so tmux doesn't wait.
 * Hook events are already processed in Phase 1. This handles pane cleanup and AI naming.
 */
async function phase2(
  sessions: Session[],
  paneSessionMap: Record<string, string>,
  nameCache: NameCache,
  hookChanged: boolean,
): Promise<void> {
  const home = homedir();
  const projectsDir = `${home}/.claude/projects`;

  let mapChanged = hookChanged;

  // Clean stale pane entries (panes that no longer have sessions)
  const activePaneIds = new Set(sessions.map(s => s.tmuxPane?.paneId).filter(Boolean));
  for (const paneId of Object.keys(paneSessionMap)) {
    if (!activePaneIds.has(paneId)) {
      delete paneSessionMap[paneId];
      mapChanged = true;
    }
  }

  if (mapChanged) {
    await savePaneSessions(paneSessionMap);
  }

  // AI naming: find one session with a sessionId but no name, skipping recent failures
  const namingSkips = await loadNamingSkips();
  const now = Date.now();

  // Prune expired skip entries
  let skipsDirty = false;
  for (const [sid, ts] of Object.entries(namingSkips)) {
    if (now - ts > NAMING_SKIP_TTL) {
      delete namingSkips[sid];
      skipsDirty = true;
    }
  }

  // Also clear skips for sessions that now have names
  for (const sid of Object.keys(namingSkips)) {
    if (nameCache.names[sid]) {
      delete namingSkips[sid];
      skipsDirty = true;
    }
  }

  const unnamed = sessions.find(s => {
    if (!s.tmuxPane) return false;
    const sessionId = paneSessionMap[s.tmuxPane.paneId];
    return sessionId && !nameCache.names[sessionId] && !namingSkips[sessionId];
  });

  if (unnamed?.tmuxPane) {
    const sessionId = paneSessionMap[unnamed.tmuxPane.paneId];
    if (sessionId && await acquireNamingLock()) {
      try {
        await debugLog(`phase2: generating name for session ${sessionId}`);
        const info = await findActiveSessionInfo(projectsDir, unnamed.repoPath, sessionId);
        const firstPrompt = info?.firstPrompt ?? "";
        const summary = info?.summary ?? "";
        if (firstPrompt || summary) {
          const name = await generateAIName(firstPrompt, summary);
          if (name) {
            nameCache.names[sessionId] = name;
            nameCache.sources[sessionId] = summary || firstPrompt;
            await saveNameCache(nameCache);
            await debugLog(`phase2: named session ${sessionId} → "${name}"`);

            // Apply name to window immediately (with current prefix)
            const currentWindowName = unnamed.tmuxPane.windowName;
            const prefix = currentWindowName.startsWith(ATTENTION_PREFIX) ? ATTENTION_PREFIX
              : currentWindowName.startsWith("🔄") ? "🔄" : "";
            await renameWindow(unnamed.tmuxPane.sessionName, unnamed.tmuxPane.windowIndex, `${prefix}${name}`);
          } else {
            // AI naming returned empty — skip for a while
            namingSkips[sessionId] = now;
            skipsDirty = true;
            await debugLog(`phase2: skipping session ${sessionId} (AI returned empty name)`);
          }
        } else {
          // No session data found — skip for a while
          namingSkips[sessionId] = now;
          skipsDirty = true;
          await debugLog(`phase2: skipping session ${sessionId} (no session data)`);
        }
      } finally {
        await releaseNamingLock();
      }
    }
  }

  if (skipsDirty) {
    await saveNamingSkips(namingSkips);
  }
}

main().catch(() => {
  // Never crash — just output nothing
});
