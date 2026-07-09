import type { NotificationConfig, Session, TransitionEvent } from "../types";
import type { SessionStatus } from "./status";
import { getAbovePrompt } from "./status";
import { renameWindow, getWindowName } from "./tmux";
import { sourceForSession } from "./input-source";
import { pendingToolCall } from "./hook-events";

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

/** Extract the waiting prompt text from a pane capture for notification body */
function extractBlockedBody(lastCapture?: string): string {
  if (!lastCapture) return "Waiting for input";
  const lines = lastCapture.split("\n");
  const { nearbyLines } = getAbovePrompt(lines);
  if (!nearbyLines) return "Waiting for input";
  const trimmed = nearbyLines.replace(/\s+/g, " ").trim();
  return trimmed.length > 100 ? trimmed.slice(0, 97) + "..." : trimmed;
}

/** Extract the last meaningful output line from a pane capture for "done" notification body */
function extractDoneBody(lastCapture?: string): string {
  if (!lastCapture) return "";
  const lines = lastCapture.split("\n");
  const { nearbyLines } = getAbovePrompt(lines);
  if (!nearbyLines) return "";
  const trimmed = nearbyLines.replace(/\s+/g, " ").trim();
  return trimmed.length > 100 ? trimmed.slice(0, 97) + "..." : trimmed;
}

/** Cached result of `which terminal-notifier` check */
let _hasTerminalNotifier: boolean | undefined;

function hasTerminalNotifier(): boolean {
  if (_hasTerminalNotifier !== undefined) return _hasTerminalNotifier;
  try {
    const result = Bun.spawnSync(["which", "terminal-notifier"]);
    _hasTerminalNotifier = result.exitCode === 0;
  } catch {
    _hasTerminalNotifier = false;
  }
  return _hasTerminalNotifier;
}

/** Send a macOS native notification (fire-and-forget).
 *  Uses terminal-notifier when available for clickable notifications that focus
 *  Ghostty and switch to the correct tmux window/pane.
 *  Falls back to osascript (no click action).
 *  When Ghostty is frontmost, plays sound only (no visual notification). */
function sendNativeNotification(
  title: string,
  body: string,
  pane?: { sessionName: string; windowIndex: number; paneId: string },
): void {
  try {
    // If Ghostty is frontmost: play sound only, skip visual notification.
    // Otherwise: full notification with sound (terminal-notifier or osascript).
    const soundOnly = `afplay /System/Library/Sounds/Ping.aiff >/dev/null 2>&1 &`;
    const frontCheck = `front=$(osascript -e 'tell application "System Events" to return name of first application process whose frontmost is true' 2>/dev/null); if [ "$front" = "ghostty" ]; then ${soundOnly} exit 0; fi`;

    if (hasTerminalNotifier() && pane) {
      const switchCmd = `tmux select-window -t '${pane.sessionName}:${pane.windowIndex}' && tmux select-pane -t '${pane.paneId}'`;
      Bun.spawn(["bash", "-c", [
        frontCheck,
        `terminal-notifier -title "$CSM_TITLE" -message "$CSM_BODY" -sound Ping -activate com.mitchellh.ghostty -execute "$CSM_SWITCH"`,
      ].join("; ")], {
        stdout: "ignore",
        stderr: "ignore",
        env: { ...process.env, CSM_TITLE: title, CSM_BODY: body, CSM_SWITCH: switchCmd },
      });
    } else {
      const escaped = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      Bun.spawn(["bash", "-c", [
        frontCheck,
        `osascript -e 'display notification "${escaped(body)}" with title "${escaped(title)}" sound name "Ping"'`,
      ].join("; ")], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Dispatch notifications for transition events.
 * Tier 1 (status monitor) is handled externally via state.
 * Tier 2 (window ⚡ prefix) is dispatched here.
 * Tier 3 (macOS native notification) is dispatched here.
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

    // Tier 3: macOS native notification
    if (config.nativeNotification) {
      const name = stripAllPrefixes(session.name || session.tmuxPane.windowName);
      const pane = {
        sessionName: session.tmuxPane.sessionName,
        windowIndex: session.tmuxPane.windowIndex,
        paneId: session.tmuxPane.paneId,
      };
      if (event.classification === "blocked") {
        const title = `⚡ Blocked — ${name}`;
        const body = extractBlockedBody(session.lastCapture);
        sendNativeNotification(title, body, pane);
      } else if (event.classification === "turnComplete") {
        const title = `✅ Done — ${name}`;
        const body = extractDoneBody(session.lastCapture);
        sendNativeNotification(title, body, pane);
      }
    }

    // Tier 4: phone push via ntfy — only when portkey drove the most recent input.
    // Skip unresolved sessions (no id ⇒ can't attribute).
    if (config.ntfyTopic && session.id && sourceForSession(session.id) === "portkey") {
      await sendPushNotification(event, session, config);
    }
  }
}

/** Title-case a space-delimited string ("fix auth" → "Fix Auth"). */
function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Human-facing, non-sensitive label for a push: `${repo} · ${Name}` where Name is
 * the ai-name humanized (hyphens→spaces, title-cased). Falls back to repo alone
 * when the window name carries no ai-name. Repo stays verbatim (raw dir name).
 */
export function pushLabel(session: Session): string {
  const aiName = extractAIName(session.name);
  if (!aiName) return session.repo;
  return `${session.repo} · ${titleCase(aiName.replace(/-/g, " "))}`;
}

/**
 * Non-sensitive category derived from the pending tool's NAME only (never its
 * input) — safe to cross ntfy.sh + APNs.
 */
export function pushAction(sessionId: string): string {
  const name = pendingToolCall(sessionId)?.name;
  if (name === "Bash") return "run a command";
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    return "make an edit";
  }
  if (name === "AskUserQuestion") return "answer a question";
  return "needs permission";
}

/** Cached bridge origin + when it was resolved (10-min TTL). */
let _originCache: { value: string | null; at: number } | undefined;

/**
 * Deep-link origin for the push `Click`: `config.bridgeUrl` if set, else the first
 * `https://…` token on line 1 of `tailscale serve status`
 * (`https://<host>.ts.net (tailnet only)`). Cached 10 min so a re-serve self-heals.
 */
export function bridgeOrigin(config: NotificationConfig): string | null {
  if (config.bridgeUrl) return config.bridgeUrl;
  const now = Date.now();
  if (_originCache && now - _originCache.at < 10 * 60 * 1000) return _originCache.value;
  let value: string | null = null;
  try {
    const res = Bun.spawnSync(["tailscale", "serve", "status"]);
    if (res.exitCode === 0) {
      const firstLine = new TextDecoder().decode(res.stdout).split("\n")[0] ?? "";
      const m = firstLine.match(/https:\/\/\S+/);
      if (m) value = m[0];
    }
  } catch {
    value = null;
  }
  _originCache = { value, at: now };
  return value;
}

/**
 * Tier 4: POST a phone notification to ntfy.sh. HTTP headers are ASCII/latin-1
 * only, so emoji ride the `Tags` header (ntfy prepends them to the title) and all
 * Unicode text (`·`, `—`) lives in the UTF-8 body. NEVER sends `lastCapture` or any
 * tool input/diff/command/question text — only the non-sensitive label + category.
 * 3s abort so a slow/offline ntfy can't stall the monitor's poll; failures swallowed.
 */
export async function sendPushNotification(
  event: TransitionEvent,
  session: Session,
  config: NotificationConfig,
): Promise<void> {
  const topic = config.ntfyTopic;
  if (!topic) return;

  const label = pushLabel(session);
  let title: string, tags: string, body: string;
  if (event.classification === "blocked") {
    title = "Needs your input";
    tags = "zap";
    body = `${label} — ${pushAction(session.id)}`;
  } else {
    title = "Turn complete";
    tags = "white_check_mark";
    body = label;
  }

  const headers: Record<string, string> = { Title: title, Tags: tags, Priority: "high" };
  const origin = bridgeOrigin(config);
  if (origin) headers.Click = `${origin}/?s=${session.id}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch {
    // Non-fatal — Tiers 1–3 already delivered.
  } finally {
    clearTimeout(timer);
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
