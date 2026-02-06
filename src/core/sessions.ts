import { homedir } from "os";
import type {
  Session,
  RepoGroup,
  SessionIndex,
  PaneInfo,
} from "../types";
import { listPanes, capturePane } from "./tmux";
import { findClaudeProcesses } from "./process";
import { detectStatus, estimateContextPercent } from "./status";

/**
 * Discover all Claude Code sessions using a two-phase approach:
 * Phase A: Active sessions from tmux panes (source of truth)
 * Phase B: Idle sessions from index files (secondary, filtered)
 */
export async function discoverSessions(): Promise<Session[]> {
  const home = homedir();
  const projectsDir = `${home}/.claude/projects`;

  // Phase A: Gather tmux panes and Claude processes in parallel
  const [panes, claudeProcesses] = await Promise.all([
    listPanes(),
    findClaudeProcesses(),
  ]);

  // Build a set of TTYs that have Claude processes running.
  // ps reports TTYs like "ttys001", tmux reports "/dev/ttys001".
  const claudeTtySet = new Set<string>(
    claudeProcesses.map((p) => p.tty),
  );

  // Filter panes to those with a Claude process on their TTY
  const claudePanes = panes.filter((pane) => {
    const normalizedPaneTty = pane.tty.replace(/^\/dev\//, "");
    return claudeTtySet.has(normalizedPaneTty);
  });

  // Phase A: Build active sessions from Claude panes
  const activeSessionPromises = claudePanes.map((pane) =>
    buildActiveSession(pane, projectsDir),
  );
  const activeSessions = await Promise.all(activeSessionPromises);

  // Collect active project paths to exclude from idle discovery
  const activeProjectPaths = new Set<string>(
    activeSessions.map((s) => s.repoPath),
  );

  // Phase B: Discover idle sessions from index files
  const idleSessions = await discoverIdleSessions(projectsDir, activeProjectPaths);

  return [...activeSessions, ...idleSessions];
}

/**
 * Build a Session from an active tmux pane running Claude.
 * Derives repo info from tmux + git, with best-effort enrichment from JSONL/index.
 */
async function buildActiveSession(
  pane: PaneInfo,
  projectsDir: string,
): Promise<Session> {
  const repoPath = pane.currentPath;
  const repo = repoPath.split("/").filter(Boolean).pop() ?? "unknown";

  // Run all enrichments in parallel
  const [status, branch, linesModified, activeInfo] = await Promise.all([
    capturePane(pane.paneId).then(
      (captured) => detectStatus(captured, true),
      () => "input" as const,
    ),
    getGitBranch(repoPath),
    getGitLinesModified(repoPath),
    findActiveSessionInfo(projectsDir, repoPath),
  ]);

  return {
    id: activeInfo?.sessionId ?? "",
    repo,
    repoPath,
    branch,
    status,
    contextPercent: activeInfo ? estimateContextPercent(activeInfo.messageCount) : 0,
    linesModified,
    messageCount: activeInfo?.messageCount ?? 0,
    summary: activeInfo?.summary ?? "",
    modified: new Date(),
    tmuxPane: {
      paneId: pane.paneId,
      windowIndex: pane.windowIndex,
      sessionName: pane.sessionName,
    },
  };
}

/**
 * Best-effort: find the active session's info by locating the most recently
 * modified JSONL file in the Claude projects directory for this repo path.
 */
async function findActiveSessionInfo(
  projectsDir: string,
  repoPath: string,
): Promise<{ sessionId: string; messageCount: number; summary: string } | null> {
  try {
    // Claude encodes project paths by replacing / with - and prefixing with -
    // e.g. /Users/foo/bar → -Users-foo-bar
    const encodedPath = repoPath.replace(/\//g, "-");
    const projectDir = `${projectsDir}/${encodedPath}`;

    // Find the most recently modified JSONL file
    const glob = new Bun.Glob("*.jsonl");
    let newestFile: string | null = null;
    let newestMtime = 0;

    for await (const path of glob.scan({ cwd: projectDir, absolute: true })) {
      try {
        const file = Bun.file(path);
        const mtime = file.lastModified;
        if (mtime > newestMtime) {
          newestMtime = mtime;
          newestFile = path;
        }
      } catch {
        continue;
      }
    }

    if (!newestFile) return null;

    // Extract session ID from filename: {uuid}.jsonl → {uuid}
    const filename = newestFile.split("/").pop() ?? "";
    const sessionId = filename.replace(/\.jsonl$/, "");

    // Try to enrich from index file
    let messageCount = 0;
    let summary = "";

    try {
      const indexPath = `${projectDir}/sessions-index.json`;
      const raw = await Bun.file(indexPath).text();
      const index: SessionIndex = JSON.parse(raw);
      const entry = index.entries.find((e) => e.sessionId === sessionId);
      if (entry) {
        messageCount = entry.messageCount;
        summary = entry.summary || entry.firstPrompt || "";
      }
    } catch {
      // No index file or malformed — that's fine
    }

    return { sessionId, messageCount, summary };
  } catch {
    return null;
  }
}

/**
 * Phase B: Discover idle sessions from session index files.
 * Skips entries whose projectPath is already covered by an active session,
 * and entries older than 24 hours.
 */
async function discoverIdleSessions(
  projectsDir: string,
  activeProjectPaths: Set<string>,
): Promise<Session[]> {
  const glob = new Bun.Glob("*/sessions-index.json");
  const indexFiles: string[] = [];

  try {
    for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) {
      indexFiles.push(path);
    }
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  const twentyFourHours = 24 * 60 * 60 * 1000;

  for (const indexFile of indexFiles) {
    try {
      const raw = await Bun.file(indexFile).text();
      const index: SessionIndex = JSON.parse(raw);

      for (const entry of index.entries) {
        if (entry.isSidechain) continue;

        // Skip if this project has an active pane
        if (activeProjectPaths.has(entry.projectPath)) continue;

        // Skip entries older than 24h
        const modifiedMs = new Date(entry.modified).getTime();
        const ageMs = Date.now() - modifiedMs;
        if (ageMs > twentyFourHours) continue;

        const repo = entry.projectPath.split("/").filter(Boolean).pop() ?? "unknown";

        // For idle sessions, try to get last assistant message as summary
        let summary = entry.summary || entry.firstPrompt || "";
        if (entry.fullPath) {
          try {
            const lastMsg = await getLastAssistantMessage(entry.fullPath);
            if (lastMsg) {
              summary = lastMsg;
            }
          } catch {
            // keep existing summary
          }
        }

        const linesModified = await getGitLinesModified(entry.projectPath);
        const contextPercent = estimateContextPercent(entry.messageCount);

        sessions.push({
          id: entry.sessionId,
          repo,
          repoPath: entry.projectPath,
          branch: entry.gitBranch || "",
          status: "idle",
          contextPercent,
          linesModified,
          messageCount: entry.messageCount,
          summary,
          modified: new Date(entry.modified),
          tmuxPane: undefined,
        });
      }
    } catch {
      continue;
    }
  }

  return sessions;
}

/**
 * Get the current git branch for a project path.
 * Returns empty string if not a git repo or command fails.
 */
async function getGitBranch(projectPath: string): Promise<string> {
  try {
    const output = await Bun.$`git -C ${projectPath} branch --show-current`.quiet().text();
    return output.trim();
  } catch {
    return "";
  }
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
