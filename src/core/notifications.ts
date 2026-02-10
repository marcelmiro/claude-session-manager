import type { NotificationConfig, Session, TransitionEvent } from "../types";
import type { SessionStatus } from "./status";
import { renameWindow, getWindowName, sendBell, displayMessage } from "./tmux";

const ATTENTION_PREFIX = "⚡";

/**
 * Detect status transitions between refresh cycles.
 * Pure function — compares previous status map with current sessions.
 */
export function detectTransitions(
  previousStatuses: Map<string, SessionStatus>,
  sessions: Session[],
): TransitionEvent[] {
  const events: TransitionEvent[] = [];

  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const key = session.tmuxPane.paneId;
    const prev = previousStatuses.get(key);

    if (!prev || prev === session.status) continue;

    const classification = classifyTransition(prev, session.status);
    events.push({
      sessionKey: key,
      previousStatus: prev,
      currentStatus: session.status,
      classification,
      session,
    });
  }

  return events;
}

/**
 * Classify a status transition.
 * running → waiting = blocked (Claude needs tool approval)
 * running → ready = turnComplete (Claude finished its turn)
 * anything else = none
 */
export function classifyTransition(
  prev: string,
  current: string,
): "blocked" | "turnComplete" | "none" {
  if (prev === "running" && current === "waiting") return "blocked";
  if (prev === "running" && current === "ready") return "turnComplete";
  return "none";
}

/**
 * Dispatch notifications for transition events across all 3 tiers.
 * Tier 1 (status widget) is handled externally via writeStatusWidget.
 * Tier 2 (window prefix) and Tier 3 (bell) are dispatched here.
 */
export async function dispatchNotifications(
  events: TransitionEvent[],
  config: NotificationConfig,
): Promise<void> {
  for (const event of events) {
    if (event.classification === "none") continue;

    const { session } = event;
    if (!session.tmuxPane) continue;

    // Tier 2: Window name ⚡ prefix
    if (config.windowPrefix) {
      const currentName = session.name || session.tmuxPane.windowName;
      if (!currentName.startsWith(ATTENTION_PREFIX)) {
        await renameWindow(
          session.tmuxPane.sessionName,
          session.tmuxPane.windowIndex,
          `${ATTENTION_PREFIX}${currentName}`,
        );
      }
    }

    // Tier 3: Bell (all transitions by default, or just blocked if configured)
    if (config.bell) {
      const shouldBell =
        config.bellOn === "all" || event.classification === "blocked";
      if (shouldBell) {
        await sendBell(session.tmuxPane.paneId);
      }
    }
  }

  // Tier 4: tmux display-message showing which session(s) transitioned
  const notable = events.filter((e) => e.classification !== "none");
  if (notable.length > 0) {
    const parts = notable.map((e) => {
      const name = e.session.name || e.session.tmuxPane?.windowName || "session";
      const what = e.classification === "blocked" ? "needs approval" : "finished";
      return `${name} ${what}`;
    });
    await displayMessage(`⚡ ${parts.join(", ")}`);
  }
}

/**
 * Clear the ⚡ prefix from a tmux window name.
 * Called when switching to a session or selecting it in the TUI.
 */
export async function clearWindowAttentionPrefix(
  sessionName: string,
  windowIndex: number,
): Promise<void> {
  const currentName = await getWindowName(sessionName, windowIndex);
  if (currentName.startsWith(ATTENTION_PREFIX)) {
    await renameWindow(sessionName, windowIndex, currentName.slice(ATTENTION_PREFIX.length));
  }
}
