import { resolve } from "path";
import type { WorktreeMode } from "../types";
import { cleanBranchToDir } from "./git";

/** Shell-quote a string for safe embedding in a compound shell command. */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Compute worktree directory path from repo name + branch name. Sanitizes / → - for flat sibling dirs. */
export function worktreeDirName(repoName: string, branchName: string): string {
  return `../${repoName}-${branchName.replace(/\//g, "-")}`;
}

interface LaunchRepo {
  name: string;
  path: string;
}
interface LaunchBranch {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
}

/**
 * Build the compound shell command run inside the spawned tmux window: git
 * setup (worktree add / checkout, if any) then `claude` — or just the git
 * setup when `withClaude` is false (shell-only launch: the window lands in
 * the worktree with a plain shell). Pure — returns the string, runs nothing;
 * may return "" (current mode, shell-only: nothing to run).
 *
 * `--end-of-options` guards the ref-argument positions where a `-`-leading value
 * could be parsed as a git option (e.g. a hostile remote branch named
 * `--upload-pack=…`). It's belt-and-suspenders with `listBranches`, which already
 * drops `-`-leading branches so they never reach here from the wizard. The bare
 * `worktree add <path> <ref>` reuse form can't take `--end-of-options` in that
 * position, so it relies on that source filter.
 */
export function buildLaunchCommand(
  mode: WorktreeMode,
  repo: LaunchRepo,
  branch: LaunchBranch,
  text: string,
  withClaude = true,
): string {
  const claudeTail = withClaude ? " && claude" : "";
  // For remote branches, fetch first so we act on the latest upstream state
  // rather than a stale `origin/<branch>` from the last fetch.
  const fetchPrefix = branch.isRemote
    ? `git fetch origin --end-of-options ${shellQuote(branch.name)} && `
    : "";

  if (mode === "new-branch") {
    const wtAbs = resolve(repo.path, worktreeDirName(repo.name, cleanBranchToDir(text)));
    const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
    // Braces group the create-or-fallback so the fetch's && short-circuits the whole worktree step on failure.
    return `${fetchPrefix}{ git worktree add ${shellQuote(wtAbs)} -b ${shellQuote(text)} --end-of-options ${shellQuote(baseRef)} 2>/dev/null || git worktree add ${shellQuote(wtAbs)} ${shellQuote(text)}; } && cd ${shellQuote(wtAbs)}${claudeTail}`;
  }

  if (mode === "reuse") {
    // Reuse the selected branch as-is — one branch, one PR. The bare
    // `worktree add <path> <branch>` DWIMs a local tracking branch for a
    // remote-only ref. The dir name is editable; branch stays fixed.
    const wtAbs = resolve(repo.path, worktreeDirName(repo.name, cleanBranchToDir(text || branch.name)));
    return `${fetchPrefix}git worktree add ${shellQuote(wtAbs)} ${shellQuote(branch.name)} && cd ${shellQuote(wtAbs)}${claudeTail}`;
  }

  if (mode === "checkout") {
    const checkout = branch.isRemote
      ? `{ git checkout -b ${shellQuote(branch.name)} --track origin/${shellQuote(branch.name)} 2>/dev/null || git checkout --end-of-options ${shellQuote(branch.name)}; }`
      : `git checkout --end-of-options ${shellQuote(branch.name)}`;
    return `${fetchPrefix}${checkout}${claudeTail}`;
  }

  // "current" — session opens on whatever branch is already checked out.
  return withClaude ? "claude" : "";
}
