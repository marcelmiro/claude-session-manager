import type { PaneInfo } from "../types.ts";

/**
 * List all tmux panes across every session and window.
 * Returns an empty array if tmux is not running or the command fails.
 */
export async function listPanes(): Promise<PaneInfo[]> {
  try {
    const output = await Bun.$`tmux list-panes -a -F '#{pane_tty} #{pane_id} #{session_name} #{window_index} #{pane_current_path}'`
      .quiet()
      .text();

    const lines = output.trim().split("\n").filter(Boolean);

    return lines.map((line) => {
      const [tty, paneId, sessionName, windowIndexStr, ...pathParts] =
        line.split(" ");
      return {
        tty,
        paneId,
        sessionName,
        windowIndex: parseInt(windowIndexStr, 10),
        currentPath: pathParts.join(" "),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Capture the last 50 lines of visible content from the given tmux pane.
 * Returns an empty string if the pane doesn't exist or tmux isn't running.
 */
export async function capturePane(paneId: string): Promise<string> {
  try {
    const output = await Bun.$`tmux capture-pane -t ${paneId} -p -S -50`
      .quiet()
      .text();
    return output;
  } catch {
    return "";
  }
}

/**
 * Write a switch-target file so the calling shell can switch to the
 * selected tmux pane after the TUI exits.
 *
 * Format: `sessionName:windowIndex:paneId`
 */
export function writeSwitchTarget(
  paneId: string,
  sessionName: string,
  windowIndex: number,
): void {
  Bun.write("/tmp/csm-switch", `${sessionName}:${windowIndex}:${paneId}`);
}
