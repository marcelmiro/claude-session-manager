import { resolve } from "path";
import { createHash } from "node:crypto";
import type { WorktreeMode } from "../types";
import { cleanBranchToDir } from "./git";

/**
 * Shell for launched windows: `$SHELL`'s basename when set, else zsh. Launch sites
 * wrap claude in `<shell> -c '…; exec <shell> -l'` so the window keeps a usable
 * login shell after claude exits — that shell should be the user's own, not a
 * hardcoded zsh that may not exist on the host.
 */
export const USER_SHELL = process.env.SHELL?.split("/").pop() || "zsh";

/** Shell-quote a string for safe embedding in a compound shell command. */
export function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9._\-\/]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Claude-native, repo-local worktree path. Friendly names stay untouched; a
 * transformed name gets a short hash so `a/b` can never collide with `a-b`.
 */
export function worktreeDirName(name: string): string {
  const slug = name
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worktree";
  const suffix = slug === name ? "" : `-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
  return `.claude/worktrees/${slug}${suffix}`;
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
    const wtAbs = resolve(repo.path, worktreeDirName(cleanBranchToDir(text)));
    const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
    // Braces group the create-or-fallback so the fetch's && short-circuits the whole worktree step on failure.
    return `${fetchPrefix}{ git worktree add ${shellQuote(wtAbs)} -b ${shellQuote(text)} --end-of-options ${shellQuote(baseRef)} 2>/dev/null || git worktree add ${shellQuote(wtAbs)} ${shellQuote(text)}; } && cd ${shellQuote(wtAbs)}${claudeTail}`;
  }

  if (mode === "reuse") {
    // Reuse the selected branch as-is — one branch, one PR. The bare
    // `worktree add <path> <branch>` DWIMs a local tracking branch for a
    // remote-only ref. The dir name is editable; branch stays fixed.
    const wtAbs = resolve(repo.path, worktreeDirName(cleanBranchToDir(text || branch.name)));
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
