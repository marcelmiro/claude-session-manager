import { PATHS } from "./config";
import type { AggregateStatus, CsmState, Session, SessionNotificationState } from "../types";

const PANE_SESSIONS_PATH = `${PATHS.dir}/pane-sessions.json`;
const HOOK_EVENTS_PATH = `${PATHS.dir}/hook-events`;

export async function loadPaneSessions(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await Bun.file(PANE_SESSIONS_PATH).text());
    // Guard against corrupted data (e.g. arrays) — must be a plain object
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch { return {}; }
}

export async function savePaneSessions(map: Record<string, string>): Promise<void> {
  try {
    await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
    await Bun.write(PANE_SESSIONS_PATH, JSON.stringify(map));
  } catch {}
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
 * Process hook events written by the SessionStart hook script.
 * Each line is `<paneId> <sessionId>`. Updates paneSessionMap in place,
 * detects session ID changes (/clear), and truncates the file.
 */
export async function processHookEvents(
  paneSessionMap: Record<string, string>,
): Promise<{ changed: boolean; changedPaneIds: Set<string> }> {
  const changedPaneIds = new Set<string>();
  let changed = false;

  try {
    const file = Bun.file(HOOK_EVENTS_PATH);
    if (!await file.exists()) return { changed, changedPaneIds };

    const raw = await file.text();
    if (!raw.trim()) return { changed, changedPaneIds };

    for (const line of raw.trim().split("\n")) {
      const parts = line.trim().split(" ");
      if (parts.length < 2) continue;
      const [paneId, sessionId] = parts;
      if (!paneId || !sessionId) continue;

      const oldId = paneSessionMap[paneId];
      if (oldId && oldId !== sessionId) {
        // Session ID changed → /clear or new session
        changedPaneIds.add(paneId);
      }
      if (oldId !== sessionId) {
        paneSessionMap[paneId] = sessionId;
        changed = true;
      }
    }

    // Truncate the file
    await Bun.write(HOOK_EVENTS_PATH, "");
  } catch {
    // Non-fatal — hook events may not exist yet
  }

  return { changed, changedPaneIds };
}
