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

// Persistent cache: paneId → sessionId, survives across refresh cycles.
// Populated by lsof (confirmed) or JSONL mtime heuristic (best-guess).
// Once set, prevents re-running the expensive heuristic every 3s.
const paneSessionCache = new Map<string, string>();

/**
 * Discover all Claude Code sessions using a two-phase approach:
 * Phase A: Active sessions from tmux panes (source of truth)
 * Phase B: Idle sessions from index files (secondary, filtered)
 */
export async function discoverSessions(opts?: { skipArchivedSummaries?: boolean; skipSessionIds?: boolean; nameMap?: Record<string, string> }): Promise<{ sessions: Session[]; changedPaneIds: Set<string> }> {
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
  // Track panes where session ID changed (e.g. after /clear)
  const changedPaneIds = new Set<string>();
  for (const { pane, sessionId } of claudePanesWithProc) {
    if (sessionId) {
      const cached = paneSessionCache.get(pane.paneId);
      if (cached && cached !== sessionId) {
        changedPaneIds.add(pane.paneId);
      }
      paneSessionCache.set(pane.paneId, sessionId);
    }
  }

  // Enrich active sessions that still couldn't resolve a session ID
  await enrichUnmatchedSessions(activeSessions, projectsDir, opts?.nameMap);

  // Clean stale cache entries for panes that no longer exist
  const activePaneIds = new Set(claudePanesWithProc.map(({ pane }) => pane.paneId));
  for (const paneId of paneSessionCache.keys()) {
    if (!activePaneIds.has(paneId)) paneSessionCache.delete(paneId);
  }

  // Phase B: Discover archived sessions from index files
  const archivedSessions = await discoverArchivedSessions(projectsDir, activeSessions, opts?.skipArchivedSummaries);

  return { sessions: [...activeSessions, ...archivedSessions], changedPaneIds };
}

/**
 * For active sessions that couldn't resolve a session ID via lsof or
 * command-line flags, try to match them using two strategies:
 *
 * 1. Window name reverse lookup (reliable): If the tmux window was previously
 *    named by CSM, look up the name in the name cache to find the session ID.
 *    Only matches unique names (skips collisions within same repo).
 *
 * 2. JSONL mtime heuristic (1:1 only): When exactly one unmatched session
 *    exists per repo, assign the most recently modified JSONL. With multiple
 *    sessions, this is unreliable (tmux pane order doesn't correlate with
 *    JSONL mtime order) so we skip it to avoid swapping metadata.
 */
async function enrichUnmatchedSessions(
  sessions: Session[],
  projectsDir: string,
  nameMap?: Record<string, string>,
): Promise<void> {
  const unmatched = sessions.filter((s) => !s.id);
  if (unmatched.length === 0) return;

  // Collect session IDs already claimed by matched sessions
  const claimedIds = new Set(sessions.filter((s) => s.id).map((s) => s.id));

  // Detect panes that share a tmux window (window name is unreliable for these)
  const panesPerWindow = new Map<string, number>();
  for (const session of sessions) {
    if (!session.tmuxPane) continue;
    const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
    panesPerWindow.set(wKey, (panesPerWindow.get(wKey) ?? 0) + 1);
  }

  // Build reverse name lookup: windowName → sessionId
  // (from CSM's name cache — names were set by AI naming in a previous cycle)
  const reverseNameMap = new Map<string, string>();
  if (nameMap) {
    for (const [sessionId, name] of Object.entries(nameMap)) {
      // If two sessions share a name, mark it as ambiguous (skip during matching)
      if (reverseNameMap.has(name)) {
        reverseNameMap.set(name, ""); // empty = ambiguous
      } else {
        reverseNameMap.set(name, sessionId);
      }
    }
  }

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
      const repoName = repoPath.split("/").filter(Boolean).pop() ?? "";

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

      candidates.sort((a, b) => b.mtime - a.mtime);
      const candidateSet = new Set(candidates.map((c) => c.sessionId));

      // Strategy 1: Window name reverse lookup
      // Match tmux window names against the name cache to find session IDs.
      // Skip default names ("claude", repo name) and names that appear on
      // multiple unmatched panes in this repo (ambiguous).
      if (reverseNameMap.size > 0) {
        // Count window name occurrences among unmatched panes in this repo
        // to detect collisions (e.g., two panes both named "you-recently-implemented")
        const nameCount = new Map<string, number>();
        for (const session of repoSessions) {
          const wn = normalizeWindowName(session.tmuxPane?.windowName, repoName);
          if (wn) nameCount.set(wn, (nameCount.get(wn) ?? 0) + 1);
        }

        for (const session of repoSessions) {
          if (session.id) continue; // already matched

          // Skip panes in shared windows — window name is ambiguous (set to "claude/{repo}")
          if (session.tmuxPane) {
            const wKey = `${session.tmuxPane.sessionName}:${session.tmuxPane.windowIndex}`;
            if ((panesPerWindow.get(wKey) ?? 0) > 1) continue;
          }

          const windowName = normalizeWindowName(session.tmuxPane?.windowName, repoName);
          if (!windowName) continue;

          // Skip if multiple unmatched panes share this window name (ambiguous)
          if ((nameCount.get(windowName) ?? 0) > 1) continue;

          const sessionId = reverseNameMap.get(windowName);
          if (!sessionId || claimedIds.has(sessionId)) continue;

          // Verify this session ID has a JSONL candidate in this project
          if (!candidateSet.has(sessionId)) continue;

          const candidate = candidates.find((c) => c.sessionId === sessionId);
          await enrichSession(session, sessionId, candidate?.mtime, index, projectDir);
          claimedIds.add(sessionId);

          // Cache window-name matches — these are reliable (CSM set the name)
          if (session.tmuxPane) {
            paneSessionCache.set(session.tmuxPane.paneId, sessionId);
          }
        }
      }

      // Strategy 2: Content matching (pane capture vs JSONL user messages)
      // Match visible pane content against recent user messages from JSONL
      // candidates. User prompts are plain text displayed verbatim in the
      // terminal, so they match reliably after whitespace normalization.
      const unmatchedForContent = repoSessions.filter((s) => !s.id && s.lastCapture);
      const unclaimedForContent = candidates.filter((c) => !claimedIds.has(c.sessionId));

      if (unmatchedForContent.length > 0 && unclaimedForContent.length > 0) {
        const candidateMessages = await Promise.all(
          unclaimedForContent.map(async (c) => ({
            ...c,
            snippets: await extractRecentUserMessages(`${projectDir}/${c.sessionId}.jsonl`),
          })),
        );

        // Normalize pane text: strip ANSI and collapse whitespace
        const paneTexts = new Map<Session, string>();
        for (const session of unmatchedForContent) {
          const plain = stripAnsi(session.lastCapture!).replace(/\s+/g, " ");
          paneTexts.set(session, plain);
        }

        // Score each (session, candidate) pair by counting matching snippets
        const scores: Array<{ session: Session; candidateIdx: number; score: number }> = [];
        for (const [session, paneText] of paneTexts) {
          for (let ci = 0; ci < candidateMessages.length; ci++) {
            let score = 0;
            for (const snippet of candidateMessages[ci].snippets) {
              if (paneText.includes(snippet)) score++;
            }
            if (score > 0) {
              scores.push({ session, candidateIdx: ci, score });
            }
          }
        }

        // Greedy assignment: highest score first
        scores.sort((a, b) => b.score - a.score);
        const assignedSessions = new Set<Session>();
        const assignedCandidates = new Set<number>();

        for (const { session, candidateIdx } of scores) {
          if (assignedSessions.has(session) || assignedCandidates.has(candidateIdx)) continue;
          const { sessionId, mtime } = candidateMessages[candidateIdx];
          await enrichSession(session, sessionId, mtime, index, projectDir);
          claimedIds.add(sessionId);
          assignedSessions.add(session);
          assignedCandidates.add(candidateIdx);

          // Cache content-matched assignments — conversation content is unique
          if (session.tmuxPane) {
            paneSessionCache.set(session.tmuxPane.paneId, sessionId);
          }
        }
      }

      // Strategy 3: JSONL mtime heuristic (only for 1:1 case)
      // After content matching, if exactly one unmatched session remains,
      // assign the most recently modified JSONL as a last resort.
      const stillUnmatched = repoSessions.filter((s) => !s.id);
      const unclaimed = candidates.filter((c) => !claimedIds.has(c.sessionId));

      if (stillUnmatched.length === 1 && unclaimed.length >= 1) {
        const { sessionId, mtime } = unclaimed[0];
        const session = stillUnmatched[0];

        await enrichSession(session, sessionId, mtime, index, projectDir);
        claimedIds.add(sessionId);

        // NOTE: We intentionally do NOT cache mtime-heuristic assignments in
        // paneSessionCache. Only lsof-confirmed and window-name-confirmed
        // mappings should be cached, to prevent wrong mappings from persisting.
      }
    } catch {
      // Skip this repo
    }
  }
}

/** Normalize a tmux window name for matching: strip ⚡ prefix, skip defaults */
function normalizeWindowName(windowName: string | undefined, repoName: string): string | null {
  if (!windowName) return null;
  let name = windowName;
  // Strip attention prefix
  if (name.startsWith("⚡")) name = name.slice("⚡".length);
  // Skip default/generic names (including "claude/{repo}" multi-pane format)
  if (name === "claude" || name === repoName || name === "zsh" || name === "bash") return null;
  if (name.startsWith("claude/")) return null;
  return name;
}

/** Populate a session object with metadata from index/JSONL */
async function enrichSession(
  session: Session,
  sessionId: string,
  mtime: number | undefined,
  index: SessionIndex | null,
  projectDir: string,
): Promise<void> {
  session.id = sessionId;
  if (mtime) session.modified = new Date(mtime);

  const entry = index?.entries.find((e) => e.sessionId === sessionId);
  if (entry) {
    session.messageCount = entry.messageCount;
    session.summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
    session.firstPrompt = entry.firstPrompt || "";
    session.contextPercent = estimateContextPercent(entry.messageCount);
  } else {
    const prompt = await getFirstUserPrompt(`${projectDir}/${sessionId}.jsonl`);
    session.summary = prompt;
    session.firstPrompt = prompt;
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

        // Skip AI naming sessions created by `claude -p` in names.ts
        if (entry.firstPrompt?.startsWith("Name this coding session in 2-4 words")) continue;

        // Skip if this session is already active
        if (activeSessionIds.has(entry.sessionId)) continue;

        // Skip entries older than 3h
        const modifiedMs = new Date(entry.modified).getTime();
        const ageMs = Date.now() - modifiedMs;
        if (ageMs > threeHours) continue;

        const repo = entry.projectPath.split("/").filter(Boolean).pop() ?? "unknown";

        // For archived sessions, use index summary or fetch last assistant message
        let summary = (entry.summary || entry.firstPrompt || "").replace(/\s+/g, " ").trim();
        let branch = entry.gitBranch || "";
        if (!skipSummaries && entry.fullPath) {
          try {
            const tail = await readSessionTail(entry.fullPath);
            if (tail.lastMessage) {
              summary = tail.lastMessage;
            }
            // Resolve "HEAD" (detached) to actual branch from JSONL
            if (tail.gitBranch && (!branch || branch === "HEAD")) {
              branch = tail.gitBranch;
            }
          } catch {
            // keep existing summary/branch
          }
        }

        const contextPercent = estimateContextPercent(entry.messageCount);

        sessions.push({
          id: entry.sessionId,
          repo,
          repoPath: entry.projectPath,
          branch,
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

          // Skip AI naming sessions created by `claude -p` in names.ts
          if (metadata.firstPrompt?.startsWith("Name this coding session in 2-4 words")) continue;

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
export function groupSessions(sessions: Session[], priorityRepos: string[]): RepoGroup[] {
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
    const aPriority = priorityRepos.indexOf(a.name.toLowerCase());
    const bPriority = priorityRepos.indexOf(b.name.toLowerCase());
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

export interface SessionTailInfo {
  lastMessage: string;
  gitBranch: string;
}

/**
 * Read the tail of a JSONL session file and extract the last assistant message
 * and most recent git branch. Only reads the last 32KB to avoid loading multi-MB files.
 * @param maxMessageLength - truncate the last message to this length (default 200)
 */
export async function readSessionTail(sessionPath: string, maxMessageLength = 200): Promise<SessionTailInfo> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return { lastMessage: "", gitBranch: "" };

    const TAIL_SIZE = 32 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const lines = chunk.trim().split("\n").filter(Boolean);

    // If we sliced mid-file, the first line is likely truncated — skip it
    const startIdx = offset > 0 ? 1 : 0;

    let lastMessage = "";
    let gitBranch = "";

    // Walk backwards to find last assistant message and most recent non-HEAD branch
    for (let i = lines.length - 1; i >= startIdx; i--) {
      try {
        const parsed = JSON.parse(lines[i]);

        // Capture most recent non-HEAD gitBranch (HEAD = detached, not useful)
        if (!gitBranch && parsed.gitBranch && parsed.gitBranch !== "HEAD") {
          gitBranch = parsed.gitBranch;
        }

        if (!lastMessage && parsed.type === "assistant") {
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
            lastMessage = clean.length > maxMessageLength ? clean.slice(0, maxMessageLength) + "..." : clean;
          }
        }

        if (lastMessage && gitBranch) break;
      } catch {
        continue;
      }
    }

    return { lastMessage, gitBranch };
  } catch {
    return { lastMessage: "", gitBranch: "" };
  }
}

/** Convenience wrapper — returns just the last assistant message (200 char limit). */
export async function getLastAssistantMessage(sessionPath: string): Promise<string> {
  const { lastMessage } = await readSessionTail(sessionPath);
  return lastMessage;
}

/** Strip ANSI escape sequences and control characters from terminal output. */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Extract recent user messages from a JSONL session file for content matching.
 * Reads the last 32KB and walks backwards to find the last N user prompts.
 * Returns whitespace-normalized snippets (first 100 chars each, min 20 chars).
 */
async function extractRecentUserMessages(sessionPath: string, count = 3): Promise<string[]> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return [];

    const TAIL_SIZE = 32 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const lines = chunk.trim().split("\n").filter(Boolean);
    const startIdx = offset > 0 ? 1 : 0;

    const snippets: string[] = [];

    for (let i = lines.length - 1; i >= startIdx && snippets.length < count; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type !== "user") continue;

        let text = "";
        const content = parsed.message?.content;
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          const textBlock = content.find(
            (block: { type: string }) => block.type === "text",
          );
          if (textBlock?.text) text = textBlock.text;
        }

        // Skip system/meta messages, XML-prefixed content, and very short messages
        if (!text || text.startsWith("[Request interrupted") || text.trimStart().startsWith("<")) continue;

        const clean = text.replace(/\s+/g, " ").trim();
        if (clean.length < 20) continue;

        snippets.push(clean.length > 100 ? clean.slice(0, 100) : clean);
      } catch {
        continue;
      }
    }

    return snippets;
  } catch {
    return [];
  }
}
