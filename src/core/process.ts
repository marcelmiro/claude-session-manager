import type { ClaudeProcess } from "../types.ts";
import { nativeSessionIdByPid } from "./session-state";

/**
 * Session id from a claude process command line, or undefined.
 *
 * A `--fork-session` resume gets a BRAND-NEW session id — the `--resume` value is
 * only the source it copied from. Using it would alias the fork onto its parent:
 * both panes resolve to one session id, read one event log, and render the same
 * status (the symptom: a running parent makes a `ready` fork show running too).
 * So we return undefined here. The fork's real id can't come from the SessionStart
 * hook either — that fires with the PARENT id (the fork's own id isn't minted yet),
 * so the hook-owned pane map is permanently wrong for forks. `findClaudeProcesses`
 * instead recovers it from Claude's per-pid native file (`nativeSessionIdByPid`).
 */
export function sessionIdFromCommand(command: string): string | undefined {
  if (/--fork-session\b/.test(command)) return undefined;
  const m = command.match(
    /(?:--resume|-r)[\s=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
  );
  return m?.[1];
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** The id CSM dictated with `--session-id <uuid>` (create-only, so it IS the session's own id),
 *  or undefined. Authoritative for BOTH a CSM fork (whose hook records the parent id) and a
 *  CSM-created session — it's on the command line the instant the pane launches, before any
 *  hook or native file exists. External forks/sessions carry no `--session-id`, so they keep
 *  the native-file / --resume resolution below. */
export function dictatedSessionId(command: string): string | undefined {
  return command.match(new RegExp(`--session-id[\\s=]+(${UUID_RE.source})`))?.[1];
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

      // Prefer an id CSM dictated with `--session-id` — authoritative and instant for
      // both a CSM fork (whose hook records the PARENT id) and a CSM-created session,
      // present on the command line before any hook or native file exists. Otherwise
      // extract from --resume/-r (fast, no lsof); a fork's --resume points at its PARENT,
      // so sessionIdFromCommand suppresses it, and the REAL id is recovered from Claude's
      // per-pid native file (the hook only ever records the parent id — see
      // nativeSessionIdByPid). Native recovery also lets claudeTtyMap prefer the real
      // `claude` binary over its `zsh -c` wrapper (both carry `--fork-session`, but only
      // the binary has a native file), since it's the process with a resolved sessionId.
      const pid = parseInt(pidStr, 10);
      const isFork = /--fork-session\b/.test(command);
      const sessionId =
        dictatedSessionId(command) ??
        (isFork ? ((await nativeSessionIdByPid(pid)) ?? undefined) : sessionIdFromCommand(command));
      results.push({ pid, tty, command, sessionId, isFork });
    }

    return results;
  } catch {
    return [];
  }
}
