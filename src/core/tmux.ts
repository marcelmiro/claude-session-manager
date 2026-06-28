import type { PaneInfo } from "../types.ts";

/**
 * Get the "main" tmux session name (i.e. not the popup session).
 * Falls back to the current session if only one exists.
 */
export async function getMainSession(): Promise<string | null> {
  try {
    // Popup runs in the same session context (tmux 3.3+), so current IS the main session
    const session = (await Bun.$`tmux display-message -p '#S'`.quiet().text()).trim();
    if (!session) return null;
    // Return session:windowId so new-window -a inserts after the active window
    const windowId = (await Bun.$`tmux display-message -t ${session} -p '#{window_id}'`.quiet().text()).trim();
    return windowId ? `${session}:${windowId}` : session;
  } catch {
    return null;
  }
}

/**
 * List all tmux panes across every session and window.
 * Returns an empty array if tmux is not running or the command fails.
 */
export async function listPanes(): Promise<PaneInfo[]> {
  try {
    const output = await Bun.$`tmux list-panes -a -F '#{pane_tty} #{pane_id} #{session_name} #{window_index} #{window_name} #{pane_current_path}'`
      .quiet()
      .text();

    const lines = output.trim().split("\n").filter(Boolean);

    return lines.map((line) => {
      const [tty, paneId, sessionName, windowIndexStr, windowName, ...pathParts] =
        line.split(" ");
      return {
        tty,
        paneId,
        sessionName,
        windowIndex: parseInt(windowIndexStr, 10),
        windowName,
        currentPath: pathParts.join(" "),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Capture the last 50 lines of visible content from the given tmux pane.
 * Pass escapes: true to include ANSI escape sequences (for color rendering).
 * Returns an empty string if the pane doesn't exist or tmux isn't running.
 *
 * Scraper-fallback width caveat (Inc7 #4): `detectStatus` patterns assume a wide
 * enough pane that the spinner/prompt lines don't wrap. CSM launches sessions with
 * `tmux new-window` (inherits the client width) and must not reflow existing panes,
 * so there is no `new-session -x 120` site to pin. This only affects pre-hook
 * sessions on the scraper path; event-status (now primary) is width-independent.
 */
export async function capturePane(
  paneId: string,
  options?: { escapes?: boolean },
): Promise<string> {
  try {
    const args = ["-t", paneId, "-p", "-J", "-S", "-50"];
    if (options?.escapes) args.push("-e");
    const output = await Bun.$`tmux capture-pane ${args}`.quiet().text();
    return output;
  } catch {
    return "";
  }
}

/**
 * Rename a tmux window.
 */
export async function renameWindow(
  sessionName: string,
  windowIndex: number,
  name: string,
): Promise<void> {
  try {
    // Use Bun.spawnSync instead of Bun.$ to avoid a Bun shell bug where
    // multiple interpolated variables with Unicode chars (like ⚡) cause
    // internal variable names to leak into arguments.
    Bun.spawnSync(["tmux", "rename-window", "-t", `${sessionName}:${windowIndex}`, name]);
  } catch {
    // window may have closed
  }
}

/**
 * Kill a tmux pane by its ID.
 */
export async function killPane(paneId: string): Promise<void> {
  try {
    await Bun.$`tmux kill-pane -t ${paneId}`.quiet();
  } catch {
    // pane may already be gone
  }
}


/**
 * Get the current window name for a tmux session:window.
 */
export async function getWindowName(sessionName: string, windowIndex: number): Promise<string> {
  try {
    const output = await Bun.$`tmux display-message -t ${sessionName}:${windowIndex} -p '#{window_name}'`.quiet().text();
    return output.trim();
  } catch {
    return "";
  }
}

/**
 * Display a brief message in the tmux status bar.
 * Uses -c to target the most recently active client, so it works from
 * background processes that aren't attached to a tmux client.
 */
export async function displayMessage(message: string): Promise<void> {
  try {
    // Get the most recently active tmux client
    const client = (await Bun.$`tmux list-clients -F '#{client_name}'`.quiet().text()).trim().split("\n")[0];
    if (client) {
      await Bun.$`tmux display-message -c ${client} ${message}`.quiet();
    }
  } catch {
    // no tmux clients attached
  }
}

/**
 * Send key names (e.g. "Enter", "Down", "Escape") to a tmux pane.
 */
export async function sendKeys(paneId: string, keys: string[]): Promise<void> {
  try {
    const args = ["-t", paneId, ...keys];
    await Bun.$`tmux send-keys ${args}`.quiet();
  } catch {
    // pane may have closed
  }
}

/**
 * Send literal text followed by Enter to a tmux pane.
 * Uses -l for the text (no key-name interpretation), then `;` to chain
 * a second send-keys for Enter — all in one tmux invocation to avoid races.
 */
export async function sendTextAndEnter(paneId: string, text: string): Promise<void> {
  try {
    // tmux splits on `;` before parsing flags, so -l only applies to text, not to the `;`
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", text, ";", "send-keys", "-t", paneId, "Enter"]);
  } catch {
    // pane may have closed
  }
}

/**
 * Send keys ONE AT A TIME with a small gap between them.
 *
 * tmux coalesces a multi-key `send-keys` into a single write, and Claude's TUI
 * then silently DROPS arrow-key escape sequences (`Down`/`Right` = `\e[B`/`\e[C`)
 * and mangles rapid digit toggles when they arrive back-to-back — verified live:
 * batched `Down Down Enter` selected the default option, not the third. Spacing the
 * keys out makes every one register in order. The 250ms gap is empirically the
 * floor that reliably lands a multiSelect digit→digit→Right→Enter sequence (130ms
 * dropped keys; 250ms verified live end-to-end).
 */
export async function sendKeysSequential(
  paneId: string,
  keys: string[],
  gapMs = 250,
): Promise<void> {
  for (const key of keys) {
    await sendKeys(paneId, [key]);
    await Bun.sleep(gapMs);
  }
}

/**
 * Answer an on-screen AskUserQuestion by pressing the option's NUMBER.
 *
 * Claude's question menu is numbered (`1. Apple`, `2. Banana`, …), so the digit is
 * an ABSOLUTE selector — it can't be thrown off by where the cursor starts or by
 * arrow keys being dropped (the old `Down`×n navigation silently picked the first
 * option; verified live). Keys go out sequentially via `sendKeysSequential`.
 *
 * - single-select (`number`): press the option's digit — it selects AND submits.
 * - multiSelect (`number[]`): press each option's digit to toggle its checkbox,
 *   then `Right` (to the Submit tab) + `Enter`.
 *
 * Keyed by paneId because the caller (TUI) already holds the pane; the Impl #3
 * bridge resolves sessionId→paneId before calling. Caller gates on event-status.
 */
export async function answerQuestion(
  paneId: string,
  selection: number | number[],
): Promise<void> {
  await sendKeysSequential(paneId, questionAnswerKeys(selection));
}

/**
 * Pure key-sequence builder for `answerQuestion` (extracted for testability).
 * `selection` is 0-based; the emitted digit is 1-based to match the menu labels.
 *
 * - single-select (`number`): `[String(idx + 1)]` — the digit selects and submits.
 * - multiSelect (`number[]`): de-duped + ascending digits (toggle each), then
 *   `Right`+`Enter` (→ Submit tab, then submit).
 */
export function questionAnswerKeys(selection: number | number[]): string[] {
  if (typeof selection === "number") {
    return [String(selection + 1)];
  }
  const sorted = [...new Set(selection)].sort((a, b) => a - b);
  return [...sorted.map((idx) => String(idx + 1)), "Right", "Enter"];
}

/**
 * Switch to the target tmux pane directly via tmux commands.
 * Works from within a tmux display-popup since tmux commands are server-side.
 */
export async function switchToPane(
  paneId: string,
  sessionName: string,
  windowIndex: number,
): Promise<void> {
  try {
    await Bun.$`tmux select-window -t ${sessionName}:${windowIndex}`.quiet();
    await Bun.$`tmux select-pane -t ${paneId}`.quiet();
  } catch {
    // ignore — pane may have closed between selection and switch
  }
}
