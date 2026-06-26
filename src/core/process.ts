import type { ClaudeProcess } from "../types.ts";

/**
 * Session id from a claude process command line, or undefined.
 *
 * A `--fork-session` resume gets a BRAND-NEW session id — the `--resume` value is
 * only the source it copied from. Using it would alias the fork onto its parent:
 * both panes resolve to one session id, read one event log, and render the same
 * status (the symptom: a running parent makes a `ready` fork show running too).
 * For a fork we return undefined and let the SessionStart hook supply the fork's
 * real id (falling back to the pane scraper until it does).
 */
export function sessionIdFromCommand(command: string): string | undefined {
  if (/--fork-session\b/.test(command)) return undefined;
  const m = command.match(
    /(?:--resume|-r)[\s=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
  );
  return m?.[1];
}

/**
 * Finds running Claude Code CLI processes and maps them to TTYs.
 * Parses `ps -eo pid,tty,command` output to locate processes whose
 * command contains "claude", filtering out grep artifacts and entries
 * with no associated TTY.
 *
 * Session IDs are resolved via the SessionStart hook (see `processHookEvents`).
 * The --resume flag on the command line provides a fast fallback.
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

      // Only match the actual Claude Code CLI process, not MCP servers or
      // other helpers that happen to live under ~/.claude/ paths.
      // Matches: "claude", "/usr/local/bin/claude --flag", "node .../claude-code/cli.mjs"
      // Rejects: "node /Users/x/.claude/local/mcp-server-foo/index.js"
      const isClaude =
        /(?:^|\s|\/)claude(?:\s|$)/.test(command) || // "claude" as binary name
        /\/claude-code\//.test(command);                // npm package path (requires dir context)
      if (!isClaude) continue;

      // Filter out the grep process itself (if somehow captured)
      if (command.includes("grep")) continue;

      // Skip entries with no associated TTY
      if (tty === "??") continue;

      // Extract session ID from --resume/-r (fast, no lsof needed); a fork's
      // --resume points at its PARENT, so sessionIdFromCommand suppresses it.
      results.push({
        pid: parseInt(pidStr, 10),
        tty,
        command,
        sessionId: sessionIdFromCommand(command),
      });
    }

    return results;
  } catch {
    return [];
  }
}
