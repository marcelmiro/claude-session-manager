import { readdir, unlink, rename, writeFile, mkdir } from "node:fs/promises";
import { PATHS } from "./config";
import type { AggregateStatus, CsmState, Session, SessionNotificationState } from "../types";

// The pane→session map is hook-owned: the SessionStart hook writes one file per pane
// (`panes/<paneId>` → sessionId) atomically (temp+rename), so there's a single durable
// source of truth with no shared-file write race and no consume-once log. Every reader
// (TUI, monitor, bridge) sees the same state — fixing the old bug where a session was
// listed but unsendable because only the monitor persisted the truncate-once event log.
const PANES_DIR = `${PATHS.dir}/panes`;
const PANE_SESSIONS_PATH = `${PATHS.dir}/pane-sessions.json`; // legacy (pre-v7); read-only fallback
const HOOK_EVENTS_PATH = `${PATHS.dir}/hook-events`; // legacy (pre-v7); drained by migratePaneMap

/** Read the hook-owned per-pane map. Falls back to the legacy single-file map only when the
 *  `panes/` dir doesn't exist yet (a pre-v7 machine before `csm setup` runs the migration). */
export async function loadPaneSessions(): Promise<Record<string, string>> {
  let files: string[];
  try {
    files = await readdir(PANES_DIR);
  } catch {
    return loadLegacyPaneSessions();
  }
  const map: Record<string, string> = {};
  await Promise.all(files.map(async (f) => {
    if (f.endsWith(".tmp")) return; // in-flight atomic write
    try {
      const sid = (await Bun.file(`${PANES_DIR}/${f}`).text()).trim();
      if (sid) map[f] = sid;
    } catch {}
  }));
  return map;
}

async function loadLegacyPaneSessions(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await Bun.file(PANE_SESSIONS_PATH).text());
    // Guard against corrupted data (e.g. arrays) — must be a plain object
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

/** Persist resolved pane→session entries as per-pane files (atomic temp+rename, one file per
 *  pane → no shared-file contention). Additive — never deletes; pruning is liveness-gated
 *  (`reconcilePaneFiles`). Captures fallback-resolved (--resume / window-name / mtime) panes
 *  the hook never wrote, so `resolveSessionPane` (bridge sends) can find them too. */
export async function savePaneSessions(map: Record<string, string>): Promise<void> {
  try {
    await mkdir(PANES_DIR, { recursive: true });
    await Promise.all(Object.entries(map).map(async ([paneId, sessionId]) => {
      if (!paneId || !sessionId) return;
      const dest = `${PANES_DIR}/${paneId}`;
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, sessionId);
      await rename(tmp, dest);
    }));
  } catch {}
}

/** Drop per-pane files for panes that have truly left tmux, bounding dir growth. Liveness-gated
 *  on the full live-pane set (not "has a claude process") so a transient ps/tmux miss can't
 *  delete a still-live mapping — preserving the old disk-survives-a-cache-miss safety net. */
export async function reconcilePaneFiles(livePaneIds: Set<string>): Promise<void> {
  try {
    const files = await readdir(PANES_DIR);
    await Promise.all(files.map(async (f) => {
      if (f.endsWith(".tmp") || livePaneIds.has(f)) return;
      try { await unlink(`${PANES_DIR}/${f}`); } catch {}
    }));
  } catch {}
}

/** One-time pre-v7 migration (idempotent; run on every `csm setup`): fold the legacy single-file
 *  map plus any residual hook-events append log into per-pane files, so sessions already running
 *  at upgrade time stay resolvable without waiting for their next SessionStart. */
export async function migratePaneMap(): Promise<void> {
  const map = await loadLegacyPaneSessions();
  try {
    const raw = await Bun.file(HOOK_EVENTS_PATH).text();
    for (const line of raw.trim().split("\n")) {
      const [paneId, sessionId] = line.trim().split(" ");
      if (paneId && sessionId) map[paneId] = sessionId;
    }
  } catch {}
  if (Object.keys(map).length) await savePaneSessions(map);
}

const EMPTY_STATE: CsmState = {
  lastUpdatedBy: "tui",
  lastUpdatedAt: 0,
  sessions: {},
};

export async function loadState(): Promise<CsmState> {
  try {
    const raw = await Bun.file(PATHS.state).text();
    const parsed = JSON.parse(raw);
    if (parsed.sessions && parsed.lastUpdatedBy) return parsed;
  } catch {
    // No state or malformed
  }
  return { ...EMPTY_STATE, sessions: {} };
}

export async function saveState(state: CsmState): Promise<void> {
  try {
    await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
    await Bun.write(PATHS.state, JSON.stringify(state));
  } catch {
    // Non-fatal
  }
}

export function computeAggregate(state: CsmState): AggregateStatus {
  let needsAttention = 0;
  let running = 0;
  let waiting = 0;
  let ready = 0;

  for (const s of Object.values(state.sessions)) {
    if (s.needsAttention) needsAttention++;
    if (s.status === "running") running++;
    if (s.status === "waiting") waiting++;
    if (s.status === "ready") ready++;
  }

  return { needsAttention, running, waiting, ready };
}

/**
 * Build session notification state map from current sessions.
 * Preserves attention flags from existing state when sessions still need attention.
 */
export function buildSessionStates(
  sessions: Session[],
  needsAttention: Set<string>,
  attentionTypes: Map<string, "blocked" | "turnComplete">,
  previousStates?: Record<string, SessionNotificationState>,
): Record<string, SessionNotificationState> {
  const states: Record<string, SessionNotificationState> = {};

  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const key = session.tmuxPane.paneId;
    const prev = previousStates?.[key];
    states[key] = {
      status: session.status,
      needsAttention: needsAttention.has(key),
      attentionType: attentionTypes.get(key),
      tmuxSession: session.tmuxPane.sessionName,
      tmuxWindow: session.tmuxPane.windowIndex,
      tmuxPane: session.tmuxPane.paneId,
      windowName: session.name || session.tmuxPane.windowName,
      // Preserve original transition time; only set when newly added to attention
      lastTransition: needsAttention.has(key)
        ? (prev?.needsAttention ? prev.lastTransition : Date.now())
        : undefined,
    };
  }

  return states;
}

/**
 * Sync the in-memory pane→session map with the hook-owned per-pane files and report which
 * panes changed id (/clear, /compact mint a new id without restarting the process). Replaces
 * the old consume-once hook-events log: reading is now non-destructive, so the monitor, TUI
 * and bridge no longer race to persist a truncate-once file. `changedPaneIds` flags only panes
 * whose id CHANGED — a brand-new pane is not a "change" — preserving the original contract.
 */
export async function processHookEvents(
  paneSessionMap: Record<string, string>,
): Promise<{ changed: boolean; changedPaneIds: Set<string> }> {
  const changedPaneIds = new Set<string>();
  let changed = false;

  const fresh = await loadPaneSessions();
  for (const [paneId, sessionId] of Object.entries(fresh)) {
    const oldId = paneSessionMap[paneId];
    if (oldId && oldId !== sessionId) changedPaneIds.add(paneId);
    if (oldId !== sessionId) {
      paneSessionMap[paneId] = sessionId;
      changed = true;
    }
  }

  return { changed, changedPaneIds };
}
