import { homedir } from "os";
import type { WizardRepo, WizardBranch } from "../types";

/** Extract a Linear/Jira-style ticket ID from a branch name (e.g. ENG-2687). */
export function extractTicketId(branch: string): string | null {
  const match = branch.match(/(?:^|\/)([a-zA-Z]{2,6}-\d{2,})(?=-|\/|$)/i);
  return match ? match[1].toUpperCase() : null;
}

// Persistent cache: worktree path → base repo path (survives across refresh cycles)
const baseRepoCache = new Map<string, string>();

/**
 * Resolve a worktree path to its base repo path.
 * For non-worktree repos, returns the same path. Cached across refreshes.
 */
export async function getBaseRepoPath(repoPath: string): Promise<string> {
  if (baseRepoCache.has(repoPath)) return baseRepoCache.get(repoPath)!;
  try {
    const gitCommonDir = (await Bun.$`git -C ${repoPath} rev-parse --path-format=absolute --git-common-dir`.quiet().text()).trim();
    const basePath = gitCommonDir.replace(/\/\.git\/?$/, "");
    baseRepoCache.set(repoPath, basePath);
    return basePath;
  } catch {
    // git failed — directory may be deleted (orphaned worktree).
    // Try to find a sibling git repo whose name is a prefix of this directory.
    // Worktrees are named "../reponame-branchname", so the repo name is a prefix.
    const basePath = await inferBaseRepoFromSiblings(repoPath);
    baseRepoCache.set(repoPath, basePath);
    return basePath;
  }
}

/**
 * For deleted worktree directories, infer the base repo by scanning sibling
 * directories. Worktrees are named `reponame-branchname`, so we look for
 * existing git repos in the same parent whose name is a prefix of this dir.
 * Picks the longest matching prefix to avoid false positives.
 */
async function inferBaseRepoFromSiblings(repoPath: string): Promise<string> {
  try {
    const parts = repoPath.split("/");
    const dirName = parts.pop() ?? "";
    const parentDir = parts.join("/");
    if (!dirName || !parentDir) return repoPath;

    const glob = new Bun.Glob("*");
    let bestMatch = "";
    let bestPath = "";

    for await (const entry of glob.scan({ cwd: parentDir, onlyFiles: false })) {
      // Skip self and entries that aren't a prefix
      if (entry === dirName) continue;
      if (!dirName.startsWith(entry + "-")) continue;

      // Check if this sibling is a git repo
      const candidatePath = `${parentDir}/${entry}`;
      const hasGit = await Bun.file(`${candidatePath}/.git/HEAD`).exists();
      if (hasGit && entry.length > bestMatch.length) {
        bestMatch = entry;
        bestPath = candidatePath;
      }
    }

    return bestPath || repoPath;
  } catch {
    return repoPath;
  }
}

/**
 * List all worktrees for a repo via `git worktree list --porcelain`.
 * Returns `{ path, branch }` for every working tree, main first (`branch` is the
 * short name, or "detached"). Returns null when `basePath` isn't a git repo (e.g.
 * a session running in a non-repo dir like ~) so the caller can skip it.
 */
async function listWorktrees(basePath: string): Promise<Array<{ path: string; branch: string }> | null> {
  try {
    const out = await Bun.$`git -C ${basePath} worktree list --porcelain`.quiet().text();
    const entries: Array<{ path: string; branch: string }> = [];
    let cur: { path?: string; branch?: string } = {};
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (cur.path) entries.push({ path: cur.path, branch: cur.branch || "detached" });
        cur = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("branch refs/heads/")) {
        cur.branch = line.slice("branch refs/heads/".length);
      } else if (line === "detached") {
        cur.branch = "detached";
      }
    }
    if (cur.path) entries.push({ path: cur.path, branch: cur.branch || "detached" });
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

/**
 * Base-repo ordering: priority repos first (in configured order), then repos with an
 * active session, then alphabetical. Shared so callers can insert extra entries (e.g.
 * the bridge's "~" home row) into the same order.
 */
export function compareRepos(
  a: { name: string; hasSession?: boolean },
  b: { name: string; hasSession?: boolean },
  priorityRepos: string[],
): number {
  const ap = priorityRepos.indexOf(a.name.toLowerCase());
  const bp = priorityRepos.indexOf(b.name.toLowerCase());
  if (ap !== -1 && bp !== -1) return ap - bp;
  if (ap !== -1) return -1;
  if (bp !== -1) return 1;
  if (!!a.hasSession !== !!b.hasSession) return a.hasSession ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Discover git repos from session display rows + configured paths.
 * Returns a flat, display-ordered list: each base repo followed by its linked
 * worktrees (nested rows). Order: priority repos first, then repos with active
 * sessions, then alphabetical. Worktrees sort alphabetically under their base.
 */
export async function discoverRepos(
  sessionRepos: Array<{ name: string; path: string }>,
  repoPaths: string[],
  priorityRepos: string[],
): Promise<WizardRepo[]> {
  const bases = new Map<string, { name: string; path: string; hasSession: boolean }>();

  // Base repos from current sessions (worktrees resolved to their base).
  for (const r of sessionRepos) {
    const basePath = baseRepoCache.get(r.path) ?? r.path;
    const baseName = basePath.split("/").filter(Boolean).pop() ?? r.name;
    const existing = bases.get(basePath);
    if (existing) existing.hasSession = true;
    else bases.set(basePath, { name: baseName, path: basePath, hasSession: true });
  }

  // Scan configured repoPaths 1-level deep (these are always base repos: a real
  // repo has a `.git/` dir, whereas a worktree's `.git` is a file — so scanning
  // never picks up worktree dirs; those come from `git worktree list` below).
  for (let rp of repoPaths) {
    rp = rp.replace(/^~/, homedir());
    try {
      const glob = new Bun.Glob("*");
      for await (const entry of glob.scan({ cwd: rp, onlyFiles: false })) {
        const fullPath = `${rp}/${entry}`;
        const gitExists = await Bun.file(`${fullPath}/.git/HEAD`).exists();
        if (gitExists && !bases.has(fullPath)) {
          bases.set(fullPath, { name: entry, path: fullPath, hasSession: false });
        }
      }
    } catch {
      // path doesn't exist or not scannable
    }
  }

  // Order bases: priority first, then active-session repos, then alphabetical.
  const ordered = [...bases.values()].sort((a, b) => compareRepos(a, b, priorityRepos));

  // Flatten: each base repo followed by its worktrees (nested rows).
  const repos: WizardRepo[] = [];
  for (const base of ordered) {
    const worktrees = await listWorktrees(base.path);
    if (!worktrees) continue; // not a git repo (e.g. a session running in ~) — skip
    const main = worktrees.find((w) => w.path === base.path) ?? worktrees[0];
    const linked = worktrees
      .filter((w) => w !== main)
      .sort((a, b) => a.branch.localeCompare(b.branch));

    repos.push({ name: base.name, path: base.path, currentBranch: main?.branch || "main", hasSession: base.hasSession });
    linked.forEach((w, i) => {
      repos.push({
        name: base.name,
        path: w.path,
        currentBranch: w.branch,
        isWorktree: true,
        isLastWorktree: i === linked.length - 1,
      });
    });
  }

  return repos;
}

/**
 * List branches for a repo. Dedup local/remote, sort: current first, local alpha, remote-only alpha.
 */
export async function listBranches(repoPath: string): Promise<WizardBranch[]> {
  try {
    const output = await Bun.$`git -C ${repoPath} branch --all`.quiet().text();
    const lines = output.trim().split("\n").filter(Boolean);

    const localBranches = new Map<string, WizardBranch>();
    const remoteBranches = new Map<string, WizardBranch>();
    let currentBranch = "";

    for (let line of lines) {
      const isCurrent = line.startsWith("* ");
      line = line.replace(/^\*?\s+/, "");

      // Skip HEAD pointer
      if (line.includes("HEAD")) continue;

      if (line.startsWith("remotes/origin/")) {
        const name = line.replace("remotes/origin/", "");
        if (!remoteBranches.has(name)) {
          remoteBranches.set(name, {
            name,
            isRemote: true,
            isCurrent: false,
            fullRef: line,
          });
        }
      } else {
        if (isCurrent) currentBranch = line;
        localBranches.set(line, {
          name: line,
          isRemote: false,
          isCurrent,
          fullRef: line,
        });
      }
    }

    // No dedup: show both local and remote so user can search "remotes/origin/main"
    const branches: WizardBranch[] = [];

    // Current branch first
    if (currentBranch && localBranches.has(currentBranch)) {
      branches.push(localBranches.get(currentBranch)!);
    }

    // Local branches (alpha, skip current)
    const localSorted = [...localBranches.values()]
      .filter((b) => !b.isCurrent)
      .sort((a, b) => a.name.localeCompare(b.name));
    branches.push(...localSorted);

    // All remote branches (alpha)
    const remoteSorted = [...remoteBranches.values()]
      .sort((a, b) => a.name.localeCompare(b.name));
    branches.push(...remoteSorted);

    return branches;
  } catch {
    return [];
  }
}

/**
 * Get git log for a branch (colored, graph format).
 */
export async function getBranchLog(repoPath: string, branch: string): Promise<string> {
  try {
    const output = await Bun.$`git -C ${repoPath} log --oneline --decorate --graph --color=always -20 ${branch}`.quiet().text();
    return output;
  } catch {
    return "";
  }
}

/**
 * Checkout an existing local branch.
 */
export async function checkoutBranch(repoPath: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await Bun.$`git -C ${repoPath} checkout ${branch}`.quiet();
    return { ok: true };
  } catch (e: any) {
    const msg = e?.stderr?.toString?.() || e?.message || "checkout failed";
    return { ok: false, error: msg.trim() };
  }
}

/**
 * Create a local tracking branch and check it out.
 */
export async function trackAndCheckout(repoPath: string, localName: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // Check if a local branch with this name already exists
    const localExists = await Bun.$`git -C ${repoPath} show-ref --verify --quiet refs/heads/${localName}`.quiet().then(() => true, () => false);
    if (localExists) {
      await Bun.$`git -C ${repoPath} checkout ${localName}`.quiet();
    } else {
      await Bun.$`git -C ${repoPath} checkout -b ${localName} --track origin/${localName}`.quiet();
    }
    return { ok: true };
  } catch (e: any) {
    const msg = e?.stderr?.toString?.() || e?.message || "track+checkout failed";
    return { ok: false, error: msg.trim() };
  }
}

/**
 * Create a git worktree with a new branch.
 * Runs: git worktree add <wtPath> -b <newBranch> <baseRef>
 * baseRef = origin/<baseBranch> if remote, else <baseBranch>
 */
export async function createWorktree(
  repoPath: string,
  wtPath: string,
  newBranch: string,
  baseBranch: string,
  isRemote: boolean,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const baseRef = isRemote ? `origin/${baseBranch}` : baseBranch;
    // If branch already exists locally, use it directly instead of -b (which fails on existing branches)
    const branchExists = await Bun.$`git -C ${repoPath} show-ref --verify --quiet refs/heads/${newBranch}`.quiet().then(() => true, () => false);
    if (branchExists) {
      await Bun.$`git -C ${repoPath} worktree add ${wtPath} ${newBranch}`.quiet();
    } else {
      await Bun.$`git -C ${repoPath} worktree add ${wtPath} -b ${newBranch} ${baseRef}`.quiet();
    }
    return { ok: true };
  } catch (e: any) {
    const msg = e?.stderr?.toString?.() || e?.message || "worktree creation failed";
    // Strip git's "Preparing worktree..." progress line to surface the actual error
    const error = msg.trim().split("\n").filter((l: string) => !l.startsWith("Preparing worktree")).join(" ").trim()
      || msg.trim();
    return { ok: false, error };
  }
}
