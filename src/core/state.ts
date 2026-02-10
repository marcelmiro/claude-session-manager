import { PATHS } from "./config";
import type { AggregateStatus, CsmState, Session, SessionNotificationState } from "../types";

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
