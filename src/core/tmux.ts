import type { PaneInfo } from "../types.ts";

/**
 * Get the "main" tmux session name (i.e. not the popup session).
 * Falls back to the current session if only one exists.
 */
export async function getMainSession(): Promise<string | null> {
  try {
    const output = await Bun.$`tmux list-sessions -F '#{session_name}'`.quiet().text();
    const sessions = output.trim().split("\n").filter(Boolean);
    const current = (await Bun.$`tmux display-message -p '#S'`.quiet().text()).trim();
    return sessions.find((s) => s !== current) ?? sessions[0] ?? null;
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
