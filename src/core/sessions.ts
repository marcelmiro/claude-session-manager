import { homedir } from "os";
import type {
  Session,
  RepoGroup,
  SessionIndex,
  PaneInfo,
} from "../types";
import { listPanes, capturePane } from "./tmux";
import { findClaudeProcesses } from "./process";
import { detectStatus, estimateContextPercent, type StatusResult } from "./status";

const PRIORITY_REPOS = ["throxy"];

// Persistent cache: paneId → sessionId, survives across refresh cycles.
// Populated by lsof (confirmed) or JSONL mtime heuristic (best-guess).
// Once set, prevents re-running the expensive heuristic every 3s.
const paneSessionCache = new Map<string, string>();

/**
 * Discover all Claude Code sessions using a two-phase approach:
 * Phase A: Active sessions from tmux panes (source of truth)
 * Phase B: Idle sessions from index files (secondary, filtered)
 */
export async function discoverSessions(opts?: { skipArchivedSummaries?: boolean; skipSessionIds?: boolean }): Promise<Session[]> {
  const home = homedir();
  const projectsDir = `${home}/.claude/projects`;

  // Phase A: Gather tmux panes and Claude processes in parallel
  // skipSessionIds skips the expensive lsof call (1-3s cold start) for fast initial render
  const [panes, claudeProcesses] = await Promise.all([
    listPanes(),
    findClaudeProcesses({ skipSessionIds: opts?.skipSessionIds }),
  ]);

  // Build a TTY→process map. ps reports "ttys001", tmux reports "/dev/ttys001".
  // When multiple processes share a TTY (parent/child), prefer one with a sessionId.
  const claudeTtyMap = new Map<string, typeof claudeProcesses[0]>();
  for (const proc of claudeProcesses) {
    const existing = claudeTtyMap.get(proc.tty);
    if (!existing || proc.sessionId) {
      claudeTtyMap.set(proc.tty, proc);
    }
  }

  // Filter panes to those with a Claude process on their TTY
  const claudePanesWithProc: Array<{ pane: PaneInfo; sessionId?: string }> = [];
  for (const pane of panes) {
    const normalizedPaneTty = pane.tty.replace(/^\/dev\//, "");
    const proc = claudeTtyMap.get(normalizedPaneTty);
    if (proc) {
      claudePanesWithProc.push({ pane, sessionId: proc.sessionId });
    }
  }

  // Phase A: Build active sessions from Claude panes
  const activeSessionPromises = claudePanesWithProc.map(({ pane, sessionId }) =>
    buildActiveSession(pane, projectsDir, sessionId ?? paneSessionCache.get(pane.paneId)),
  );
  const activeSessions = await Promise.all(activeSessionPromises);

  // Update cache: lsof-confirmed mappings override any heuristic guess
  for (const { pane, sessionId } of claudePanesWithProc) {
    if (sessionId) paneSessionCache.set(pane.paneId, sessionId);
  }

  // Enrich active sessions that still couldn't resolve a session ID
  await enrichUnmatchedSessions(activeSessions, projectsDir);

  // Clean stale cache entries for panes that no longer exist
  const activePaneIds = new Set(claudePanesWithProc.map(({ pane }) => pane.paneId));
  for (const paneId of paneSessionCache.keys()) {
    if (!activePaneIds.has(paneId)) paneSessionCache.delete(paneId);
  }

  // Phase B: Discover archived sessions from index files
  const archivedSessions = await discoverArchivedSessions(projectsDir, activeSessions, opts?.skipArchivedSummaries);

  return [...activeSessions, ...archivedSessions];
}

/**
 * For active sessions that couldn't resolve a session ID via lsof,
 * try to assign distinct index entries from the same project.
 *
 * Uses JSONL file mtime (not index timestamps) to identify which sessions
 * are actually active — active Claude processes continuously write to their
 * JSONL files, so recently-modified files correspond to running sessions.
 */
async function enrichUnmatchedSessions(sessions: Session[], projectsDir: string): Promise<void> {
  const unmatched = sessions.filter((s) => !s.id);
  if (unmatched.length === 0) return;

  // Collect session IDs already claimed by matched sessions
  const claimedIds = new Set(sessions.filter((s) => s.id).map((s) => s.id));

  // Group unmatched sessions by repoPath
  const byRepo = new Map<string, Session[]>();
  for (const session of unmatched) {
    const existing = byRepo.get(session.repoPath);
    if (existing) {
      existing.push(session);
    } else {
      byRepo.set(session.repoPath, [session]);
    }
  }

  for (const [repoPath, repoSessions] of byRepo) {
    try {
      const encodedPath = repoPath.replace(/\//g, "-");
      const projectDir = `${projectsDir}/${encodedPath}`;

      // Read the index once for summary lookup
      let index: SessionIndex | null = null;
      try {
        const raw = await Bun.file(`${projectDir}/sessions-index.json`).text();
        index = JSON.parse(raw);
      } catch {
        // No index — will fall back to JSONL first prompt
      }

      // Scan JSONL files and rank by actual file mtime (most recently written = active)
      const jsonlGlob = new Bun.Glob("*.jsonl");
      const candidates: Array<{ sessionId: string; mtime: number }> = [];

      for await (const path of jsonlGlob.scan({ cwd: projectDir, absolute: true })) {
        const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "");
        if (claimedIds.has(sessionId)) continue;

        try {
          const stat = await Bun.file(path).stat();
          if (stat) candidates.push({ sessionId, mtime: stat.mtimeMs });
        } catch {
          continue;
        }
      }

      // Sort by mtime desc — most recently written JSONL files first
      candidates.sort((a, b) => b.mtime - a.mtime);

      // Assign one per unmatched session
      for (let i = 0; i < repoSessions.length && i < candidates.length; i++) {
        const { sessionId, mtime } = candidates[i];
        const session = repoSessions[i];

        // Use JSONL file mtime as authoritative last-activity time
        session.modified = new Date(mtime);

        // Enrich from index if available
        const entry = index?.entries.find((e) => e.sessionId === sessionId);
        if (entry) {
          session.id = entry.sessionId;
          session.messageCount = entry.messageCount;
          session.summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
          session.firstPrompt = entry.firstPrompt || "";
          session.contextPercent = estimateContextPercent(entry.messageCount);
        } else {
          // No index entry — read first prompt from JSONL
          session.id = sessionId;
          const prompt = await getFirstUserPrompt(`${projectDir}/${sessionId}.jsonl`);
          session.summary = prompt;
          session.firstPrompt = prompt;
        }

        claimedIds.add(sessionId);

        // Cache so this pane keeps its assignment across refreshes
        if (session.tmuxPane) {
          paneSessionCache.set(session.tmuxPane.paneId, sessionId);
        }
      }
    } catch {
      // Skip this repo
    }
  }
}

/**
 * Build a Session from an active tmux pane running Claude.
 * Derives repo info from tmux + git, with best-effort enrichment from JSONL/index.
 */
async function buildActiveSession(
  pane: PaneInfo,
  projectsDir: string,
  knownSessionId?: string,
): Promise<Session> {
  const repoPath = pane.currentPath;
  const repo = repoPath.split("/").filter(Boolean).pop() ?? "unknown";

  // Run all enrichments in parallel — capture pane with escapes for reuse in preview
  let lastCapture = "";
  const [statusResult, branch, activeInfo] = await Promise.all([
    capturePane(pane.paneId, { escapes: true }).then(
      (captured) => {
        lastCapture = captured;
        // Strip ANSI for status detection (detectStatus expects plain text)
        const plain = captured.replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
          .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
          .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
        return detectStatus(plain, true);
      },
      (): StatusResult => ({ status: "ready" }),
    ),
    getGitBranch(repoPath),
    findActiveSessionInfo(projectsDir, repoPath, knownSessionId),
  ]);

  const contextPercent = statusResult.contextPercent
    ?? (activeInfo ? estimateContextPercent(activeInfo.messageCount) : 0);

  return {
    id: knownSessionId ?? activeInfo?.sessionId ?? "",
    repo,
    repoPath,
    branch,
    status: statusResult.status,
    contextPercent,
    messageCount: activeInfo?.messageCount ?? 0,
    summary: activeInfo?.summary ?? "",
    modified: activeInfo?.modified ? new Date(activeInfo.modified) : new Date(),
    firstPrompt: activeInfo?.firstPrompt ?? "",
    name: "",
    tmuxPane: {
      paneId: pane.paneId,
      windowIndex: pane.windowIndex,
      sessionName: pane.sessionName,
      windowName: pane.windowName,
    },
    lastCapture,
  };
}

/**
 * Find session info from the index. If knownSessionId is provided (from lsof),
 * look it up directly. Otherwise fall back to the most recently modified JSONL.
 */
async function findActiveSessionInfo(
  projectsDir: string,
  repoPath: string,
  knownSessionId?: string,
): Promise<{ sessionId: string; messageCount: number; summary: string; modified?: string; firstPrompt: string } | null> {
  try {
    // Claude encodes project paths by replacing / with - and prefixing with -
    // e.g. /Users/foo/bar → -Users-foo-bar
    const encodedPath = repoPath.replace(/\//g, "-");
    const projectDir = `${projectsDir}/${encodedPath}`;

    // Without a known session ID we can't reliably match — enrichment
    // for unmatched sessions happens in enrichUnmatchedSessions() instead
    if (!knownSessionId) return null;
    const sessionId = knownSessionId;

    // Look up session in the index
    let messageCount = 0;
    let summary = "";
    let modified: string | undefined;
    let firstPrompt = "";

    try {
      const indexPath = `${projectDir}/sessions-index.json`;
      const raw = await Bun.file(indexPath).text();
      const index: SessionIndex = JSON.parse(raw);
      const entry = index.entries.find((e) => e.sessionId === sessionId);
      if (entry) {
        messageCount = entry.messageCount;
        summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
        modified = entry.modified;
        firstPrompt = entry.firstPrompt || "";
      }
    } catch {
      // No index file or malformed — that's fine
    }

    // Use JSONL file mtime as authoritative last-activity time —
    // the file is written on every message, so mtime is always accurate
    // (unlike the index which may update lazily)
    const jsonlPath = `${projectDir}/${sessionId}.jsonl`;
    try {
      const stat = await Bun.file(jsonlPath).stat();
      if (stat) {
        modified = new Date(stat.mtimeMs).toISOString();
      }
    } catch {
      // Keep index-derived modified
    }

    // If no summary from index, read first user prompt from the JSONL
    if (!summary) {
      summary = await getFirstUserPrompt(jsonlPath);
      if (!firstPrompt) firstPrompt = summary;
    }

    return { sessionId, messageCount, summary, modified, firstPrompt };
  } catch {
    return null;
  }
}

/**
 * Phase B: Discover archived sessions from session index files.
 * Skips entries that match an active session (same project + session ID),
 * and entries older than 24 hours.
 */
async function discoverArchivedSessions(
  projectsDir: string,
  activeSessions: Session[],
  skipSummaries = false,
): Promise<Session[]> {
  // Build set of active session IDs to avoid duplicating active sessions as archived
  const activeSessionIds = new Set<string>(
    activeSessions.filter((s) => s.id).map((s) => s.id),
  );

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
  const threeHours = 3 * 60 * 60 * 1000;
  const indexSessionIds = new Set<string>();

  for (const indexFile of indexFiles) {
    try {
      const raw = await Bun.file(indexFile).text();
      const index: SessionIndex = JSON.parse(raw);

      for (const entry of index.entries) {
        indexSessionIds.add(entry.sessionId);

        if (entry.isSidechain) continue;

        // Skip if this session is already active
        if (activeSessionIds.has(entry.sessionId)) continue;

        // Skip entries older than 3h
        const modifiedMs = new Date(entry.modified).getTime();
        const ageMs = Date.now() - modifiedMs;
        if (ageMs > threeHours) continue;

        const repo = entry.projectPath.split("/").filter(Boolean).pop() ?? "unknown";

        // For archived sessions, use index summary or fetch last assistant message
        let summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
        if (!skipSummaries && entry.fullPath) {
          try {
            const lastMsg = await getLastAssistantMessage(entry.fullPath);
            if (lastMsg) {
              summary = lastMsg;
            }
          } catch {
            // keep existing summary
          }
        }

        const contextPercent = estimateContextPercent(entry.messageCount);

        sessions.push({
          id: entry.sessionId,
          repo,
          repoPath: entry.projectPath,
          branch: entry.gitBranch || "",
          status: "archived",
          contextPercent,
          messageCount: entry.messageCount,
          summary,
          modified: new Date(entry.modified),
          firstPrompt: entry.firstPrompt || "",
          name: "",
          tmuxPane: undefined,
        });
      }
    } catch {
      continue;
    }
  }

  // Fallback: scan for JSONL files not covered by any index
  // When skipSummaries is set, skip the expensive JSONL parse entirely — only stat for recency
  if (!skipSummaries) {
    try {
      const jsonlGlob = new Bun.Glob("*/*.jsonl");
      for await (const path of jsonlGlob.scan({ cwd: projectsDir, absolute: true })) {
        try {
          const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "");

          // Skip if already known from active sessions or index files
          if (activeSessionIds.has(sessionId) || indexSessionIds.has(sessionId)) continue;

          // Check mtime — skip files older than 3h (cheap stat, no file read)
          const file = Bun.file(path);
          const stat = await file.stat();
          if (!stat) continue;
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs > threeHours) continue;

          // Parse the JSONL for metadata
          const metadata = await parseJsonlMetadata(path);
          if (!metadata) continue;

          const repo = metadata.projectPath.split("/").filter(Boolean).pop() ?? "unknown";
          const summary = metadata.lastAssistantMessage || metadata.firstPrompt || "";
          const contextPercent = estimateContextPercent(metadata.messageCount);

          sessions.push({
            id: sessionId,
            repo,
            repoPath: metadata.projectPath,
            branch: metadata.gitBranch,
            status: "archived",
            contextPercent,
            messageCount: metadata.messageCount,
            summary,
            modified: new Date(stat.mtimeMs),
            firstPrompt: metadata.firstPrompt || "",
            name: "",
            tmuxPane: undefined,
          });
        } catch {
          continue;
        }
      }
    } catch {
      // Glob scan failed — not fatal
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
    waiting: 0,
    running: 1,
    ready: 2,
    idle: 3,
    archived: 4,
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
    // Sort sessions: by status priority asc, then by stable key.
    // Avoid sorting by modified time — active sessions get new Date() each refresh,
    // which causes same-status sessions to shuffle order between cycles.
    groupSessions.sort((a, b) => {
      const statusDiff = statusPriority[a.status] - statusPriority[b.status];
      if (statusDiff !== 0) return statusDiff;
      const aKey = a.tmuxPane?.paneId ?? a.id;
      const bKey = b.tmuxPane?.paneId ?? b.id;
      return aKey.localeCompare(bKey);
    });

    // Use the repoPath from the first session as the group path
    const path = groupSessions[0].repoPath;

    groups.push({ name, path, sessions: groupSessions });
  }

  // Sort groups: priority repos first (in array order), then alphabetical
  groups.sort((a, b) => {
    const aPriority = PRIORITY_REPOS.indexOf(a.name.toLowerCase());
    const bPriority = PRIORITY_REPOS.indexOf(b.name.toLowerCase());
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;
    if (aPriority !== -1) return -1;
    if (bPriority !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  return groups;
}

interface JsonlMetadata {
  projectPath: string;
  gitBranch: string;
  messageCount: number;
  firstPrompt: string;
  lastAssistantMessage: string;
}

/**
 * Parse a JSONL session file and extract metadata for archived session discovery.
 * Returns null if the session is a sidechain or the file is invalid.
 */
async function parseJsonlMetadata(filePath: string): Promise<JsonlMetadata | null> {
  try {
    const raw = await Bun.file(filePath).text();
    const lines = raw.split("\n");

    let projectPath = "";
    let gitBranch = "";
    let messageCount = 0;
    let firstPrompt = "";
    let lastAssistantMessage = "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        // Extract project metadata from the first line that has cwd
        // (metadata fields like cwd, gitBranch, isSidechain appear on user/assistant/system lines)
        if (!projectPath && parsed.cwd) {
          if (parsed.isSidechain) return null;
          projectPath = parsed.cwd || "";
          gitBranch = parsed.gitBranch || "";
        }

        if (parsed.type === "user") {
          messageCount++;

          // Extract first user prompt (reuse same filtering logic as getFirstUserPrompt)
          if (!firstPrompt) {
            let text = "";
            const content = parsed.message?.content;
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const textBlock = content.find(
                (block: { type: string }) => block.type === "text",
              );
              if (textBlock?.text) {
                text = textBlock.text;
              }
            }
            if (text && !text.startsWith("[Request interrupted") && !text.trimStart().startsWith("<")) {
              const clean = text.replace(/\s+/g, " ").trim();
              firstPrompt = clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
            }
          }
        }

        if (parsed.type === "assistant") {
          messageCount++;

          // Track last assistant message
          let text = "";
          if (typeof parsed.message?.content === "string") {
            text = parsed.message.content;
          } else if (Array.isArray(parsed.message?.content)) {
            const textBlock = parsed.message.content.find(
              (block: { type: string }) => block.type === "text",
            );
            if (textBlock?.text) {
              text = textBlock.text;
            }
          }
          if (text) {
            const clean = text.replace(/\s+/g, " ").trim();
            lastAssistantMessage = clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
          }
        }
      } catch {
        continue;
      }
    }

    // If we couldn't determine a project path, the file is not useful
    if (!projectPath) return null;

    return { projectPath, gitBranch, messageCount, firstPrompt, lastAssistantMessage };
  } catch {
    return null;
  }
}

/**
 * Read a JSONL session file and extract the first user prompt.
 * Returns a truncated string (first 200 chars) or empty string on failure.
 */
async function getFirstUserPrompt(sessionPath: string): Promise<string> {
  try {
    const raw = await Bun.file(sessionPath).text();
    const lines = raw.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== "user") continue;

        let text = "";
        const content = parsed.message?.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find(
            (block: { type: string }) => block.type === "text",
          );
          if (textBlock?.text) {
            text = textBlock.text;
          }
        }

        // Skip system/meta messages and anything starting with XML tags
        if (!text || text.startsWith("[Request interrupted") || text.trimStart().startsWith("<")) {
          continue;
        }

        // Collapse whitespace and truncate
        const clean = text.replace(/\s+/g, " ").trim();
        return clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
      } catch {
        continue;
      }
    }

    return "";
  } catch {
    return "";
  }
}

/**
 * Read a JSONL session file and extract the last assistant message.
 * Only reads the last 32KB of the file to avoid loading multi-MB JSONL files.
 * Returns a truncated summary (first 200 chars) or empty string on failure.
 */
export async function getLastAssistantMessage(sessionPath: string): Promise<string> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return "";

    const TAIL_SIZE = 32 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const lines = chunk.trim().split("\n").filter(Boolean);

    // If we sliced mid-file, the first line is likely truncated — skip it
    const startIdx = offset > 0 ? 1 : 0;

    // Walk backwards to find the last assistant message
    for (let i = lines.length - 1; i >= startIdx; i--) {
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
            const clean = text.replace(/\s+/g, " ").trim();
            return clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
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
