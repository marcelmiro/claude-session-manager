import type { ClaudeProcess } from "../types.ts";

/**
 * Finds running Claude Code CLI processes and maps them to TTYs.
 * Parses `ps -eo pid,tty,command` output to locate processes whose
 * command contains "claude", filtering out grep artifacts and entries
 * with no associated TTY.
 *
 * When skipSessionIds is true, skips the expensive lsof call and returns
 * processes without session IDs (fast path for initial render).
 */
export async function findClaudeProcesses(opts?: { skipSessionIds?: boolean }): Promise<ClaudeProcess[]> {
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
        /claude-code/.test(command);                  // npm package path
      if (!isClaude) continue;

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

    // Batch-resolve session IDs from open file handles (skip on fast path)
    if (!opts?.skipSessionIds && results.length > 0) {
      const pidSessionMap = await resolveSessionIds(results.map((r) => r.pid));
      for (const proc of results) {
        proc.sessionId = pidSessionMap.get(proc.pid);
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Use lsof to find which session ID each Claude PID has open.
 * Claude processes keep an open handle to ~/.claude/tasks/{sessionId}/.
 */
export async function resolveSessionIds(pids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const pidArg = pids.join(",");
    const output = await Bun.$`/usr/sbin/lsof -p ${pidArg}`.quiet().nothrow().text();

    // Match lines containing .claude/tasks/{uuid}
    const taskDirRegex = /\.claude\/tasks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

    for (const line of output.split("\n")) {
      const match = line.match(taskDirRegex);
      if (!match) continue;

      // Extract PID from the line (second whitespace-delimited field)
      const pidMatch = line.match(/^\S+\s+(\d+)/);
      if (!pidMatch) continue;

      const pid = parseInt(pidMatch[1], 10);
      // Always overwrite: lsof lists FDs in ascending order, so the last
      // match has the highest FD (most recently opened) — this is the
      // current session after /clear, not a stale previous session.
      map.set(pid, match[1]);
    }
  } catch {
    // lsof may not be available or may fail — that's fine
  }
  return map;
}
