import { homedir } from "os";
import type {
  Session,
  RepoGroup,
  SessionIndex,
} from "../types";
import { listPanes, capturePane } from "./tmux";
import { findClaudeProcesses } from "./process";
import { detectStatus, estimateContextPercent } from "./status";

/**
 * Discover all Claude Code sessions by scanning session index files
 * and correlating them with running tmux panes and Claude processes.
 */
export async function discoverSessions(): Promise<Session[]> {
  const home = homedir();
  const projectsDir = `${home}/.claude/projects`;

  // Scan for all sessions-index.json files
  const glob = new Bun.Glob("*/sessions-index.json");
  const indexFiles: string[] = [];
  try {
    for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) {
      indexFiles.push(path);
    }
  } catch {
    // projects dir may not exist
    return [];
  }

  // Gather tmux panes and Claude processes in parallel
  const [panes, claudeProcesses] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
  ]);

  // Build a set of TTYs that have Claude processes running.
  // ps reports TTYs like "ttys001", tmux reports "/dev/ttys001".
  // Normalize by stripping the "/dev/" prefix for comparison.
  const claudeTtySet = new Set<string>(
    claudeProcesses.map((p) => p.tty),
  );

  // Pre-compute which panes are running Claude by checking TTY overlap
  const claudePanes = panes.filter((pane) => {
    const normalizedPaneTty = pane.tty.replace(/^\/dev\//, "");
    return claudeTtySet.has(normalizedPaneTty);
  });

  const sessions: Session[] = [];

  // Track panes already claimed by a session so one pane isn't shared
  const claimedPaneIds = new Set<string>();

  for (const indexFile of indexFiles) {
    try {
      const raw = await Bun.file(indexFile).text();
      const index: SessionIndex = JSON.parse(raw);

      for (const entry of index.entries) {
        // Skip sidechain sessions
        if (entry.isSidechain) continue;

        // Derive repo name from projectPath: last path segment
        const repo = entry.projectPath.split("/").filter(Boolean).pop() ?? "unknown";

        // Try to match this session to an active tmux pane.
        // A pane matches if its currentPath exactly equals the session's projectPath
        // (or is a subdirectory of it) AND it hasn't been claimed already.
        const matchedPane = claudePanes.find((pane) => {
          if (claimedPaneIds.has(pane.paneId)) return false;
          // Exact match or subdirectory (ensure path boundary with trailing /)
          return (
            pane.currentPath === entry.projectPath ||
            pane.currentPath.startsWith(entry.projectPath + "/")
          );
        });

        let status: Session["status"] = "idle";
        let tmuxPane: Session["tmuxPane"] | undefined;

        if (matchedPane) {
          claimedPaneIds.add(matchedPane.paneId);
          tmuxPane = {
            paneId: matchedPane.paneId,
            windowIndex: matchedPane.windowIndex,
            sessionName: matchedPane.sessionName,
          };

          try {
            const captured = await capturePane(matchedPane.paneId);
            status = detectStatus(captured, true);
          } catch {
            status = "input"; // process exists but capture failed
          }
        }

        // Skip stale idle sessions (no active pane AND older than 24 hours)
        if (status === "idle") {
          const modifiedMs = new Date(entry.modified).getTime();
          const ageMs = Date.now() - modifiedMs;
          const twentyFourHours = 24 * 60 * 60 * 1000;
          if (ageMs > twentyFourHours) continue;
        }

        const linesModified = await getGitLinesModified(entry.projectPath);
        const contextPercent = estimateContextPercent(entry.messageCount);

        // For idle sessions, try to get last assistant message as summary
        let summary = entry.summary || entry.firstPrompt || "";
        if (status === "idle" && entry.fullPath) {
          try {
            const lastMsg = await getLastAssistantMessage(entry.fullPath);
            if (lastMsg) {
              summary = lastMsg;
            }
          } catch {
            // keep existing summary
          }
        }

        sessions.push({
          id: entry.sessionId,
          repo,
          repoPath: entry.projectPath,
          branch: entry.gitBranch || "",
          status,
          contextPercent,
          linesModified,
          messageCount: entry.messageCount,
          summary,
          modified: new Date(entry.modified),
          tmuxPane,
        });
      }
    } catch {
      // Skip malformed or unreadable index files
      continue;
    }
  }

  return sessions;
}

/**
 * Group sessions by repo name, sorted alphabetically.
 * Sessions within each group are sorted by status priority, then by modified desc.
 */
export function groupSessions(sessions: Session[]): RepoGroup[] {
  const statusPriority: Record<Session["status"], number> = {
    input: 0,
    running: 1,
    idle: 2,
  };

  // Group by repo name
  const groupMap = new Map<string, Session[]>();

  for (const session of sessions) {
    const existing = groupMap.get(session.repo);
    if (existing) {
      existing.push(session);
    } else {
      groupMap.set(session.repo, [session]);
    }
  }

  // Build RepoGroup array
  const groups: RepoGroup[] = [];

  for (const [name, groupSessions] of groupMap) {
    // Sort sessions: by status priority asc, then by modified desc
    groupSessions.sort((a, b) => {
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      return b.modified.getTime() - a.modified.getTime();
    });

    // Use the repoPath from the first session as the group path
    const path = groupSessions[0].repoPath;

    groups.push({ name, path, sessions: groupSessions });
  }

  // Sort groups alphabetically by name
  groups.sort((a, b) => a.name.localeCompare(b.name));

  return groups;
}

/**
 * Get total lines modified (insertions + deletions) from git diff --stat.
 * Returns 0 if the command fails or there are no changes.
 */
export async function getGitLinesModified(projectPath: string): Promise<number> {
  try {
    const output = await Bun.$`git -C ${projectPath} diff --stat`.quiet().text();
    const lines = output.trim().split("\n");
    if (lines.length === 0) return 0;

    const lastLine = lines[lines.length - 1];

    // Parse line like: " 5 files changed, 120 insertions(+), 30 deletions(-)"
    let total = 0;

    const insertionMatch = lastLine.match(/(\d+)\s+insertion/);
    if (insertionMatch) {
      total += parseInt(insertionMatch[1], 10);
    }

    const deletionMatch = lastLine.match(/(\d+)\s+deletion/);
    if (deletionMatch) {
      total += parseInt(deletionMatch[1], 10);
    }

    return total;
  } catch {
    return 0;
  }
}

/**
 * Read a JSONL session file and extract the last assistant message.
 * Returns a truncated summary (first 200 chars) or empty string on failure.
 */
export async function getLastAssistantMessage(sessionPath: string): Promise<string> {
  try {
    const raw = await Bun.file(sessionPath).text();
    const lines = raw.trim().split("\n").filter(Boolean);

    // Walk backwards to find the last assistant message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type === "assistant") {
          // Content may be a string or an array of content blocks
          let text = "";
          if (typeof parsed.message?.content === "string") {
            text = parsed.message.content;
          } else if (Array.isArray(parsed.message?.content)) {
            // Find the first text block
            const textBlock = parsed.message.content.find(
              (block: { type: string }) => block.type === "text",
            );
            if (textBlock?.text) {
              text = textBlock.text;
            }
          }

          if (text) {
            return text.length > 200 ? text.slice(0, 200) + "..." : text;
          }
        }
      } catch {
        // Skip malformed JSON lines
        continue;
      }
    }

    return "";
  } catch {
    return "";
  }
}
