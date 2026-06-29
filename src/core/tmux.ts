import type { PaneInfo } from "../types.ts";

/**
 * Get the "main" tmux session name (i.e. not the popup session).
 *
 * Prefers the session of an ATTACHED client: the bridge runs as a detached
 * background process, so `display-message -p '#S'` would resolve to tmux's
 * most-recently-active session — non-deterministic, and not necessarily the one
 * the user is sitting in. Targeting the attached client keeps phone-created
 * sessions landing where the user actually works. Falls back to the current
 * session when nothing is attached (e.g. the TUI popup, which shares context).
 */
export async function getMainSession(): Promise<string | null> {
  try {
    // An attached client's session is the user's real session; the bridge isn't a client.
    const attached = (await Bun.$`tmux list-clients -F '#{client_session}'`.quiet().text())
      .trim()
      .split("\n")
      .filter(Boolean)[0];
    // Popup runs in the same session context (tmux 3.3+), so current IS the main session
    const session = attached || (await Bun.$`tmux display-message -p '#S'`.quiet().text()).trim();
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
 *
 * The text and the Enter MUST be separate tmux writes with a gap between them.
 * A chained `send-keys -l text ; send-keys Enter` (one coalesced write) makes the
 * bytes arrive in a single burst, which Claude's TUI reads as a *paste*: the
 * trailing `\r` is absorbed as a newline inside the input box instead of
 * submitting, so the message sits in the prompt unsent (and stacks up on retry).
 * This is the same coalescing hazard documented in `sendKeysSequential`. Sending
 * the text, pausing, then sending a standalone Enter lets Claude commit the input
 * and interpret the Enter as a submit.
 */
export async function sendTextAndEnter(paneId: string, text: string): Promise<void> {
  try {
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", text]);
    await Bun.sleep(250);
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "Enter"]);
  } catch {
    // pane may have closed
  }
}

/** Send a single tmux key/chord (e.g. "Up", "Enter", "Escape", "C-u") to a pane. */
export async function sendKey(paneId: string, key: string): Promise<void> {
  try {
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, key]);
  } catch {
    // pane may have closed
  }
}

/** Send literal text to a pane WITHOUT a trailing Enter (cf. sendTextAndEnter). */
export async function sendLiteral(paneId: string, text: string): Promise<void> {
  try {
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", text]);
  } catch {
    // pane may have closed
  }
}

/**
 * Send text wrapped in bracketed-paste markers (`ESC[200~ … ESC[201~`), i.e. exactly what
 * a real terminal paste looks like. This is the trigger that makes Claude Code's TUI treat
 * an image file path as an inline `[Image #N]` attachment (verified live: a BARE
 * `send-keys -l <path>` stays literal text; the bracketed-paste form attaches). Claude
 * base64-embeds the file's bytes at paste time, so the file must exist now but is safe to
 * delete after submit.
 */
export async function sendBracketedPaste(paneId: string, text: string): Promise<void> {
  try {
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-l", `\x1b[200~${text}\x1b[201~`]);
  } catch {
    // pane may have closed
  }
}

/**
 * Launch `claude` in a NEW tmux window in `repoPath`, inserted after the active
 * window (`-a`), mirroring the TUI's simple-case new-session launch (index.ts). The
 * window command is `claude` directly — no shell wrapper — so there's no send-keys
 * race with shell init. `targetSession` is `session:windowId` from getMainSession().
 * Returns the new window's pane id (`-P -F '#{pane_id}'`) so the caller can wait for
 * that pane's SessionStart hook to register the fresh session id.
 */
export async function launchClaudeWindow(
  targetSession: string,
  repoPath: string,
  name: string,
): Promise<string> {
  const out =
    await Bun.$`tmux new-window -a -t ${targetSession} -n ${name} -c ${repoPath} -P -F ${"#{pane_id}"} claude`
      .quiet()
      .text();
  return out.trim();
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
 * - single-select (`number`): press the option's digit (highlights it), then `Enter`
 *   to submit. The digit alone only moves the cursor — it does not auto-submit.
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
 * - single-select (`number`): `[String(idx + 1), "Enter"]` — the digit highlights
 *   the option, `Enter` submits it. (The digit alone only moves the cursor; it does
 *   NOT auto-submit — verified live, cursor moved 1→2 but the answer never landed.)
 * - multiSelect (`number[]`): de-duped + ascending digits (toggle each), then
 *   `Right`+`Enter` (→ Submit tab, then submit).
 */
export function questionAnswerKeys(selection: number | number[]): string[] {
  if (typeof selection === "number") {
    return [String(selection + 1), "Enter"];
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
