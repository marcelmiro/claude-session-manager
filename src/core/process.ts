import type { ClaudeProcess } from "../types.ts";

/**
 * Finds running Claude Code CLI processes and maps them to TTYs.
 * Parses `ps -eo pid,tty,command` output to locate processes whose
 * command contains "claude", filtering out grep artifacts and entries
 * with no associated TTY.
 */
export async function findClaudeProcesses(): Promise<ClaudeProcess[]> {
  try {
    const output = await Bun.$`ps -eo pid,tty,command`.quiet().text();
    const lines = output.split("\n");

    const results: ClaudeProcess[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Skip the header line
      if (trimmed.startsWith("PID")) continue;

      // ps output format: PID TTY COMMAND (where COMMAND is the rest of the line)
      // PID and TTY are fixed-width columns, COMMAND spans the remainder.
      const match = trimmed.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;

      const [, pidStr, tty, command] = match;

      // Only include lines where the command contains "claude"
      if (!command.toLowerCase().includes("claude")) continue;

      // Filter out the grep process itself (if somehow captured)
      if (command.includes("grep")) continue;

      // Skip entries with no associated TTY
      if (tty === "??") continue;

      results.push({
        pid: parseInt(pidStr, 10),
        tty,
        command,
      });
    }

    return results;
  } catch {
    return [];
  }
}
