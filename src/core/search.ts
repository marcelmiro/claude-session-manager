import { homedir } from "os";
import type { SessionIndexEntry, SessionIndex, Session } from "../types";
import { getBaseRepoPath, extractTicketId } from "./git";
import { repoNameFromPath } from "./sessions";
import type { NameCache } from "./names";

const home = homedir();
const projectsDir = `${home}/.claude/projects`;

export interface SearchEntry {
  sessionId: string;
  projectPath: string;
  fullPath: string; // path to .jsonl file
  baseRepoPath: string;
  repo: string;
  branch: string;
  summary: string;
  firstPrompt: string; // truncated for display (~200 chars)
  name: string; // AI name from cache
  modified: Date;
  messageCount: number;
  searchText: string; // pre-built lowercase concat of all searchable fields
  isActive: boolean;
  activePaneId?: string;
  activeSessionName?: string;
  activeWindowIndex?: number;
  activeStatus?: Session["status"];
  isDeletedWorktree: boolean;
}

/** Synthetic index entry with extra field for longer search content */
interface ExtendedIndexEntry extends SessionIndexEntry {
  /** Full first prompt (not truncated) — used for searchText only */
  fullFirstPrompt?: string;
}

/**
 * Load all sessions from all sessions-index.json files.
 * No time cutoff. Skips sidechains and AI-naming sessions.
 * Cross-references with active sessions to mark them.
 */
export async function loadAllSessions(
  nameCache: NameCache,
  activeSessions: Session[],
): Promise<SearchEntry[]> {
  // Build active session lookup
  const activeById = new Map<string, Session>();
  for (const s of activeSessions) {
    if (s.id) activeById.set(s.id, s);
  }

  // Glob all index files
  const glob = new Bun.Glob("*/sessions-index.json");
  const indexFiles: string[] = [];
  try {
    for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) {
      indexFiles.push(path);
    }
  } catch {
    return [];
  }

  // Read all index files in parallel
  const indexResults = await Promise.all(
    indexFiles.map(async (indexFile) => {
      try {
        const raw = await Bun.file(indexFile).text();
        return JSON.parse(raw) as SessionIndex;
      } catch {
        return null;
      }
    }),
  );

  // Collect all entries from indexes, dedup by sessionId
  const seen = new Set<string>();
  const rawEntries: ExtendedIndexEntry[] = [];

  for (const index of indexResults) {
    if (!index?.entries) continue;
    for (const entry of index.entries) {
      if (seen.has(entry.sessionId)) continue;
      if (entry.isSidechain) continue;
      if (entry.firstPrompt?.startsWith("Name this coding session in 2-4 words")) continue;
      seen.add(entry.sessionId);
      rawEntries.push(entry);
    }
  }

  // Fallback: scan for JSONL files not covered by any index.
  // Some projects lack sessions-index.json — read minimal metadata from the JSONL header.
  try {
    const jsonlGlob = new Bun.Glob("*/*.jsonl");
    const looseJsonlPaths: string[] = [];
    for await (const path of jsonlGlob.scan({ cwd: projectsDir, absolute: true })) {
      const sessionId = path.split("/").pop()!.replace(/\.jsonl$/, "");
      // Skip subagent files (contain "/" in relative portion beyond project dir)
      if (path.includes("/subagents/")) continue;
      if (!seen.has(sessionId)) {
        looseJsonlPaths.push(path);
        seen.add(sessionId);
      }
    }

    // Parse loose JSONL headers in parallel (reads first 32KB each)
    const looseEntries = await Promise.all(
      looseJsonlPaths.map((path) => parseJsonlHeader(path)),
    );
    for (const entry of looseEntries) {
      if (entry) rawEntries.push(entry);
    }
  } catch {
    // Non-fatal: index-only search still works
  }

  // Supplement indexed entries with searchable content from JSONL files.
  // The index truncates firstPrompt at ~200 chars, losing searchable content.
  // Reading 32KB of 1000+ files is ~30ms (parallel), so this is cheap.
  await Promise.all(
    rawEntries.map(async (entry: ExtendedIndexEntry) => {
      if (entry.fullFirstPrompt) return; // already has full content (from parseJsonlHeader)
      if (!entry.fullPath) return;
      try {
        entry.fullFirstPrompt = await extractSearchContent(entry.fullPath);
      } catch {}
    }),
  );

  // Resolve base repo paths and check worktree existence in parallel
  const entries = await Promise.all(
    rawEntries.map(async (entry: ExtendedIndexEntry) => {
      let baseRepoPath = entry.projectPath;
      let isDeletedWorktree = false;

      try {
        baseRepoPath = await getBaseRepoPath(entry.projectPath);
      } catch {}

      // Check if projectPath still exists (for worktree detection)
      if (entry.projectPath !== baseRepoPath) {
        try {
          const exists = await Bun.file(`${entry.projectPath}/.git`).exists();
          if (!exists) isDeletedWorktree = true;
        } catch {
          isDeletedWorktree = true;
        }
      }

      const repo = repoNameFromPath(baseRepoPath);
      const aiName = nameCache.names[entry.sessionId] || "";
      const ticketId = extractTicketId(entry.gitBranch || "") || "";
      const activeSession = activeById.get(entry.sessionId);

      // Use fullFirstPrompt (untruncated) for searchText when available,
      // fall back to the index's truncated firstPrompt
      const searchPrompt = entry.fullFirstPrompt || entry.firstPrompt || "";
      const searchText = [
        entry.summary,
        searchPrompt,
        aiName,
        entry.gitBranch,
        repo,
        ticketId,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return {
        sessionId: entry.sessionId,
        projectPath: entry.projectPath,
        fullPath: entry.fullPath,
        baseRepoPath,
        repo,
        branch: entry.gitBranch || "",
        summary: (entry.summary || "").replace(/\s+/g, " ").trim(),
        firstPrompt: (entry.firstPrompt || "").replace(/\s+/g, " ").trim(),
        name: aiName,
        modified: new Date(entry.modified),
        messageCount: entry.messageCount,
        searchText,
        isActive: !!activeSession,
        activePaneId: activeSession?.tmuxPane?.paneId,
        activeSessionName: activeSession?.tmuxPane?.sessionName,
        activeWindowIndex: activeSession?.tmuxPane?.windowIndex,
        activeStatus: activeSession?.status,
        isDeletedWorktree,
      } satisfies SearchEntry;
    }),
  );

  // Sort by modified desc (most recent first)
  entries.sort((a, b) => b.modified.getTime() - a.modified.getTime());

  return entries;
}

/**
 * Multi-word search: all words must appear in searchText.
 * Returns score > 0 if all words match, 0 otherwise.
 * Score = sum of per-word best match scores + recency bonus.
 */
export function scoreSearchEntry(entry: SearchEntry, words: string[]): number {
  // All words must be present in searchText
  for (const word of words) {
    if (!entry.searchText.includes(word)) return 0;
  }

  // Score each word against individual fields for quality ranking.
  // Named fields (summary, name, etc.) score higher than raw searchText
  // (which includes conversation content) so metadata matches rank above
  // conversation-only matches.
  let totalScore = 0;
  const namedFields = [
    entry.summary?.toLowerCase() || "",
    entry.firstPrompt?.toLowerCase() || "",
    entry.name?.toLowerCase() || "",
    entry.branch?.toLowerCase() || "",
    entry.repo?.toLowerCase() || "",
  ];

  for (const word of words) {
    let bestWordScore = 0;

    // Score against named fields (higher tiers)
    for (const field of namedFields) {
      if (!field) continue;
      if (field === word) {
        bestWordScore = Math.max(bestWordScore, 100);
      } else if (field.startsWith(word)) {
        bestWordScore = Math.max(bestWordScore, 80);
      } else if (field.includes(word)) {
        bestWordScore = Math.max(bestWordScore, 60);
      } else {
        const fieldWords = field.split(/[-_\s]+/);
        if (fieldWords.some((w) => w.startsWith(word))) {
          bestWordScore = Math.max(bestWordScore, 40);
        }
      }
    }

    // Fall back to searchText (includes conversation content) — lower tier
    if (bestWordScore === 0 && entry.searchText.includes(word)) {
      bestWordScore = 20;
    }

    totalScore += bestWordScore;
  }

  // Recency bonus: up to 10 points for sessions modified today, decaying over 30 days
  const ageMs = Date.now() - entry.modified.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyBonus = Math.max(0, 10 - ageDays / 3);
  totalScore += recencyBonus;

  return totalScore;
}

/**
 * Extract searchable content (user + assistant text) from a JSONL file's first 32KB.
 * Returns up to MAX_SEARCH_CONTENT chars of concatenated message text.
 */
async function extractSearchContent(filePath: string): Promise<string | undefined> {
  const file = Bun.file(filePath);
  const stat = await file.stat();
  if (!stat) return undefined;

  const chunk = await file.slice(0, Math.min(stat.size, 32768)).text();
  const lines = chunk.split("\n").filter(Boolean);
  const contentParts: string[] = [];
  let totalLen = 0;
  const MAX_SEARCH_CONTENT = 3000;

  for (const line of lines) {
    if (totalLen >= MAX_SEARCH_CONTENT) break;
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== "user" && parsed.type !== "assistant") continue;
      let text = "";
      const content = parsed.message?.content;
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        const tb = content.find((b: { type: string }) => b.type === "text");
        if (tb?.text) text = tb.text;
      }
      if (!text) continue;
      if (parsed.type === "user" && (text.startsWith("[Request interrupted") || text.trimStart().startsWith("<"))) continue;
      const clean = text.replace(/\s+/g, " ").trim();
      const remaining = MAX_SEARCH_CONTENT - totalLen;
      contentParts.push(clean.length > remaining ? clean.slice(0, remaining) : clean);
      totalLen += clean.length;
    } catch { continue; }
  }

  return contentParts.length > 0 ? contentParts.join(" ") : undefined;
}

/**
 * Parse the header of a JSONL session file to extract minimal metadata.
 * Reads first 32KB. Returns a synthetic ExtendedIndexEntry or null.
 * Reuses extractSearchContent for the searchable corpus.
 */
async function parseJsonlHeader(filePath: string): Promise<ExtendedIndexEntry | null> {
  try {
    const file = Bun.file(filePath);
    const stat = await file.stat();
    if (!stat) return null;

    // Read first 32KB for metadata + first user prompt
    const chunk = await file.slice(0, Math.min(stat.size, 32768)).text();
    const lines = chunk.split("\n").filter(Boolean);

    let projectPath = "";
    let gitBranch = "";
    let firstPromptDisplay = "";
    let isSidechain = false;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);

        if (!projectPath && parsed.cwd) {
          projectPath = parsed.cwd;
          gitBranch = parsed.gitBranch || "";
          isSidechain = !!parsed.isSidechain;
        }

        if (!firstPromptDisplay && parsed.type === "user") {
          let text = "";
          const content = parsed.message?.content;
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            const tb = content.find((b: { type: string }) => b.type === "text");
            if (tb?.text) text = tb.text;
          }
          if (text && !text.startsWith("[Request interrupted") && !text.trimStart().startsWith("<")) {
            const clean = text.replace(/\s+/g, " ").trim();
            firstPromptDisplay = clean.length > 200 ? clean.slice(0, 200) + "..." : clean;
          }
        }

        if (projectPath && firstPromptDisplay) break;
      } catch {
        continue;
      }
    }

    if (!projectPath) return null;
    if (isSidechain) return null;
    if (firstPromptDisplay?.startsWith("Name this coding session in 2-4 words")) return null;

    // Extract searchable content (reuses the same 32KB already cached by OS)
    const fullFirstPrompt = await extractSearchContent(filePath);

    const sessionId = filePath.split("/").pop()!.replace(/\.jsonl$/, "");

    return {
      sessionId,
      fullPath: filePath,
      fileMtime: stat.mtimeMs,
      firstPrompt: firstPromptDisplay,
      summary: "",
      messageCount: 0,
      created: new Date(stat.mtimeMs).toISOString(),
      modified: new Date(stat.mtimeMs).toISOString(),
      gitBranch,
      projectPath,
      isSidechain: false,
      fullFirstPrompt,
    };
  } catch {
    return null;
  }
}

/**
 * Filter and rank entries by multi-word query.
 * If query is empty, returns entries sorted by recency (already the default order).
 */
export function filterAndRankEntries(
  entries: SearchEntry[],
  query: string,
  limit = 50,
): SearchEntry[] {
  if (!query.trim()) {
    return entries.slice(0, limit);
  }

  const words = query.toLowerCase().trim().split(/\s+/);

  const scored: Array<{ entry: SearchEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreSearchEntry(entry, words);
    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  // Sort by score desc, tie-break by modified desc
  scored.sort((a, b) => {
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
    return b.entry.modified.getTime() - a.entry.modified.getTime();
  });

  return scored.slice(0, limit).map((s) => s.entry);
}
