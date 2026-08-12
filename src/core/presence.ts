/**
 * "Is the user at the terminal?" — the Linux answer, shared by every process that
 * asks (monitor, TUI, bridge, and — inlined as bash — the hook scripts).
 *
 * On macOS the question is answered by frontmost-app probes (osascript in the
 * monitor, lsappinfo in the hooks — two variants on purpose: lsappinfo avoids a TCC
 * prompt). Those have no Linux analogue, and on a remote host "a tmux client is
 * attached" stops implying presence too — a persistent SSH attach is the steady
 * state even when the user is out with their phone. What tmux does know is
 * `client_activity`: the epoch of each client's last keyboard input, untouched by
 * pane output (lab-verified on tmux 3.4). Presence = any attached client with input
 * inside PRESENCE_WINDOW_MS.
 *
 * Tri-state on purpose: the call sites have hand-tuned, opposite failure polarities
 * (the monitor treats a failed probe as present; the question-hold release treats it
 * as absent). Callers map "unknown" per their own polarity — this module never
 * collapses it for them.
 */

export type Presence = "present" | "absent" | "unknown";

/**
 * How recent a client's last keystroke must be to count as "at the terminal".
 * Mirrored into the generated hook scripts as whole seconds — one constant feeds
 * both TS and bash, so a tuning change can't leave the two disagreeing.
 */
export const PRESENCE_WINDOW_MS = 60_000;
export const PRESENCE_WINDOW_S = PRESENCE_WINDOW_MS / 1000;

/**
 * Classify client-activity epochs (seconds, from `#{client_activity}`) against the
 * window. No clients ⇒ absent (nobody can be looking). Unparseable/zero epochs ⇒
 * unknown (the probe answered garbage, not "away"). Newest client wins: one active
 * client among idle ones means the user is there.
 */
export function classifyActivity(epochsSec: number[], nowMs: number): Presence {
  if (epochsSec.length === 0) return "absent";
  // Garbage rows are dropped rather than fed to Math.max, which propagates NaN —
  // one unparseable client must not mask a real fresh one.
  const finite = epochsSec.filter((e) => Number.isFinite(e) && e > 0);
  if (finite.length === 0) return "unknown";
  const newest = Math.max(...finite);
  return nowMs - newest * 1000 <= PRESENCE_WINDOW_MS ? "present" : "absent";
}

/**
 * Presence via tmux client activity, optionally scoped to one tmux session's
 * clients. Probe failure ⇒ unknown (never absent — a broken tmux must not read as
 * "the user left").
 */
export async function clientActivityPresence(tmuxSession?: string): Promise<Presence> {
  try {
    const args = tmuxSession ? ["-t", tmuxSession] : [];
    const out = await Bun.$`tmux list-clients ${args} -F ${"#{client_activity}"}`.quiet().text();
    const epochs = out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(Number);
    return classifyActivity(epochs, Date.now());
  } catch {
    return "unknown";
  }
}
