import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { githubSlug, compareUrl, branchPullRequest } from "./pull-request";

// --- githubSlug ---

test("githubSlug parses ssh, https and .git-less remotes", () => {
  expect(githubSlug("git@github.com:marcelmiro/claude-session-manager.git")).toBe("marcelmiro/claude-session-manager");
  expect(githubSlug("https://github.com/throxy-ai/throxy.git")).toBe("throxy-ai/throxy");
  expect(githubSlug("https://github.com/throxy-ai/throxy")).toBe("throxy-ai/throxy");
  expect(githubSlug("ssh://git@github.com/owner/repo.git")).toBe("owner/repo");
});

test("githubSlug rejects non-GitHub remotes rather than guessing", () => {
  expect(githubSlug("git@gitlab.com:owner/repo.git")).toBe("");
  expect(githubSlug("/srv/git/bare.git")).toBe("");
  expect(githubSlug("")).toBe("");
});

// --- compareUrl ---

test("compareUrl keeps slashes in a branch name but escapes the segments", () => {
  // `marcelmiro/eng-80-…` is a real branch shape here — a percent-encoded slash 404s.
  expect(compareUrl("https://github.com/o/r", "marcelmiro/eng-80 x")).toBe(
    "https://github.com/o/r/compare/marcelmiro/eng-80%20x?expand=1",
  );
});

// --- branchPullRequest ---

test("a repo with no remote yields no PR surface (never shells out to gh)", async () => {
  const dir = mkdtempSync(`${tmpdir()}/csm-pr-`);
  try {
    await Bun.$`git init -q ${dir}`.nothrow().quiet();
    await Bun.write(`${dir}/a.txt`, "a");
    await Bun.$`git -C ${dir} add -A`.nothrow().quiet();
    await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -qm init`.nothrow().quiet();
    expect(await branchPullRequest(dir)).toEqual({ state: "none" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default branch yields no PR surface — compare/main would target itself", async () => {
  const dir = mkdtempSync(`${tmpdir()}/csm-pr-`);
  try {
    await Bun.$`git init -q -b main ${dir}`.nothrow().quiet();
    await Bun.write(`${dir}/a.txt`, "a");
    await Bun.$`git -C ${dir} add -A`.nothrow().quiet();
    await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -qm init`.nothrow().quiet();
    await Bun.$`git -C ${dir} remote add origin git@github.com:owner/repo.git`.nothrow().quiet();
    expect(await branchPullRequest(dir)).toEqual({ state: "none" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unpushed feature branch reports local-only, not a bogus compare link", async () => {
  const dir = mkdtempSync(`${tmpdir()}/csm-pr-`);
  try {
    await Bun.$`git init -q -b main ${dir}`.nothrow().quiet();
    await Bun.write(`${dir}/a.txt`, "a");
    await Bun.$`git -C ${dir} add -A`.nothrow().quiet();
    await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -qm init`.nothrow().quiet();
    await Bun.$`git -C ${dir} remote add origin git@github.com:owner/repo.git`.nothrow().quiet();
    await Bun.$`git -C ${dir} checkout -q -b feature/x`.nothrow().quiet();
    // `gh pr view` can't reach a fake repo, so it fails and we fall through to the push check.
    expect(await branchPullRequest(dir)).toEqual({ state: "local-only", branch: "feature/x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
