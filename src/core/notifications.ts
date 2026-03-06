import type { NotificationConfig, Session, TransitionEvent } from "../types";
import type { SessionStatus } from "./status";
import { renameWindow, getWindowName } from "./tmux";

export const ATTENTION_PREFIX = "⚡";
export const RUNNING_PREFIX = "🔄";
export const NAME_SEPARATOR = "/";

/** Strip both ⚡ and 🔄 prefixes from a window name */
export function stripAllPrefixes(name: string): string {
  if (name.startsWith(ATTENTION_PREFIX)) return name.slice(ATTENTION_PREFIX.length);
  if (name.startsWith(RUNNING_PREFIX)) return name.slice(RUNNING_PREFIX.length);
  return name;
}

/** Determine the desired prefix: ⚡ > 🔄 > "" */
export function desiredPrefix(hasAttention: boolean, isRunning: boolean): string {
  if (hasAttention) return ATTENTION_PREFIX;
  if (isRunning) return RUNNING_PREFIX;
  return "";
}

/** Build the base window name: {repo}[·{ai-name}][+] */
export function buildBaseName(repo: string, aiName?: string, isFork?: boolean): string {
  let name = repo;
  if (aiName) name += `${NAME_SEPARATOR}${aiName}`;
  if (isFork) name += "+";
  return name;
}

/** Extract AI name from a window name like "{repo}·{ai-name}" or "{repo}·{ai-name}+" */
export function extractAIName(windowName: string): string | null {
  const stripped = stripAllPrefixes(windowName);
  const sepIdx = stripped.indexOf(NAME_SEPARATOR);
  if (sepIdx === -1) return null;
  let aiName = stripped.slice(sepIdx + NAME_SEPARATOR.length);
  if (aiName.endsWith("+")) aiName = aiName.slice(0, -1);
  return aiName || null;
}

/** Extract repo name from a window name like "{repo}" or "{repo}·{ai-name}" */
export function extractRepoFromWindowName(windowName: string): string {
  const stripped = stripAllPrefixes(windowName);
  const sepIdx = stripped.indexOf(NAME_SEPARATOR);
  return sepIdx === -1 ? stripped : stripped.slice(0, sepIdx);
}

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
  if (prev === "ready" && current === "waiting") return "blocked";
  if (prev === "running" && current === "ready") return "turnComplete";
  return "none";
}

/**
 * Dispatch notifications for transition events.
 * Tier 1 (status monitor) is handled externally via state.
 * Tier 2 (window ⚡ prefix) is dispatched here.
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
        const baseName = stripAllPrefixes(currentName);
        await renameWindow(
          session.tmuxPane.sessionName,
          session.tmuxPane.windowIndex,
          `${ATTENTION_PREFIX}${baseName}`,
        );
      }
    }

  }
}

/**
 * Sync the prefix (⚡/🔄/none) on a tmux window to match the desired state.
 * Callers pass the window's computed attention/running flags.
 */
export async function syncWindowPrefix(
  sessionName: string,
  windowIndex: number,
  hasAttention: boolean,
  hasRunning: boolean,
): Promise<void> {
  const currentName = await getWindowName(sessionName, windowIndex);
  if (!currentName) return;
  const baseName = stripAllPrefixes(currentName);
  const prefix = desiredPrefix(hasAttention, hasRunning);
  const desired = `${prefix}${baseName}`;
  if (currentName !== desired) {
    await renameWindow(sessionName, windowIndex, desired);
  }
}
