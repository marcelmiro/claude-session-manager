/**
 * The GitHub pull request for a repo's current branch — the phone's exit to the real review
 * surface. Portkey's changed-files view is a glance (docs/adr/0001), so rather than growing an
 * in-app reviewer it links out to the PR, where highlighting, threads and suggestions already
 * exist and match what the operator will read at their desk.
 *
 * Shells out to `gh`; every failure mode (no gh, no remote, not a GitHub remote, network down)
 * collapses to `state: "none"`, which the UI renders as nothing at all.
 */

export type PullRequestInfo =
  /** Nothing to link: default branch, no/unsupported remote, gh missing, or gh failed. */
  | { state: "none" }
  /** Branch exists only locally — there is no remote ref to open a PR against yet. */
  | { state: "local-only"; branch: string }
  /** Pushed, but no PR yet — `compareUrl` opens GitHub's "open a pull request" form. */
  | { state: "no-pr"; branch: string; compareUrl: string }
  | {
      state: "open" | "draft" | "merged" | "closed";
      branch: string;
      number: number;
      title: string;
      url: string;
      /** GitHub's review decision, when it has one: APPROVED / CHANGES_REQUESTED / … */
      reviewDecision?: string;
      /** The PR's own LOC delta — the merge-base diff GitHub shows, not the local worktree's. */
      add: number;
      del: number;
    };

/**
 * `git@github.com:owner/repo.git` / `https://github.com/owner/repo` → `owner/repo`.
 * Returns "" for a non-GitHub or unparseable remote, which callers treat as "no PR surface".
 */
export function githubSlug(remoteUrl: string): string {
  const m = remoteUrl.trim().match(/^(?:git@|ssh:\/\/git@|https:\/\/)github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : "";
}

/** GitHub's "open a pull request" form for a branch. */
export const compareUrl = (repoUrl: string, branch: string) =>
  `${repoUrl}/compare/${branch.split("/").map(encodeURIComponent).join("/")}?expand=1`;

async function git(root: string, args: string[]): Promise<string> {
  try {
    const r = await Bun.$`git -C ${root} ${args}`.nothrow().quiet();
    return r.exitCode === 0 ? r.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

export async function branchPullRequest(root: string): Promise<PullRequestInfo> {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") return { state: "none" }; // detached
  const slug = githubSlug(await git(root, ["remote", "get-url", "origin"]));
  if (!slug) return { state: "none" };

  // The default branch has no PR to link and none to open — `compare/main` would propose
  // merging main into itself. Silence, not a degraded "no PR yet".
  const def = (await git(root, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).replace(/^.*\/origin\//, "");
  if (branch === (def || "main")) return { state: "none" };

  const repoUrl = `https://github.com/${slug}`;
  let raw = "";
  try {
    const r =
      await Bun.$`gh pr view ${branch} -R ${slug} --json number,state,isDraft,title,url,reviewDecision,additions,deletions`
        .nothrow()
        .quiet();
    if (r.exitCode === 0) raw = r.stdout.toString().trim();
  } catch {
    return { state: "none" }; // gh not installed
  }

  if (raw) {
    try {
      const pr = JSON.parse(raw) as {
        number: number;
        state: string;
        isDraft: boolean;
        title: string;
        url: string;
        reviewDecision?: string;
        additions: number;
        deletions: number;
      };
      const state = pr.isDraft && pr.state === "OPEN" ? "draft" : (pr.state.toLowerCase() as "open" | "merged" | "closed");
      return {
        state,
        branch,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        add: pr.additions,
        del: pr.deletions,
        ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
      };
    } catch {
      return { state: "none" };
    }
  }

  const pushed = (await git(root, ["rev-parse", "--verify", "--quiet", `origin/${branch}`])) !== "";
  return pushed ? { state: "no-pr", branch, compareUrl: compareUrl(repoUrl, branch) } : { state: "local-only", branch };
}
