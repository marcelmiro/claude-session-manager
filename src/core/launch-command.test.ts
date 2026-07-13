import { test, expect, describe } from "bun:test";
import { buildLaunchCommand, shellQuote, worktreeDirName } from "./launch-command";

const repo = { name: "csm", path: "/tmp/proj/csm" };
const local = (name: string) => ({ name, isRemote: false, isCurrent: false });
const remote = (name: string) => ({ name, isRemote: true, isCurrent: false });

describe("shellQuote", () => {
  test("leaves safe chars (incl. branch slashes) unquoted", () => {
    expect(shellQuote("cursor/ev-4-x")).toBe("cursor/ev-4-x");
    expect(shellQuote("/tmp/proj/csm-x")).toBe("/tmp/proj/csm-x");
  });
  test("single-quotes anything with shell metachars", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("x;rm -rf /")).toBe("'x;rm -rf /'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("worktreeDirName", () => {
  test("prepends ../<repo>- and flattens slashes", () => {
    expect(worktreeDirName("csm", "ev-4")).toBe("../csm-ev-4");
    expect(worktreeDirName("csm", "a/b")).toBe("../csm-a-b");
  });
});

describe("buildLaunchCommand", () => {
  test("current mode launches claude directly", () => {
    expect(buildLaunchCommand("current", repo, { name: "main", isRemote: false, isCurrent: true }, "")).toBe("claude");
  });

  test("reuse: no -b, branch stays fixed, dir derives from text", () => {
    const cmd = buildLaunchCommand("reuse", repo, local("feature"), "feature");
    expect(cmd).toBe("git worktree add /tmp/proj/csm-feature feature && cd /tmp/proj/csm-feature && claude");
    expect(cmd).not.toContain("-b "); // the whole point: reuse never forks
  });

  test("reuse remote-only: fetches first, reuses the same branch name (one branch)", () => {
    const cmd = buildLaunchCommand("reuse", repo, remote("cursor/ev-4-x"), "ev-4-x");
    expect(cmd).toContain("git fetch origin --end-of-options cursor/ev-4-x && ");
    // dir cleaned from the editable text; branch stays the full remote name
    expect(cmd).toContain("git worktree add /tmp/proj/csm-ev-4-x cursor/ev-4-x && cd /tmp/proj/csm-ev-4-x && claude");
    expect(cmd).not.toContain("-b ");
  });

  test("new-branch local: -b <text> with --end-of-options guarding the base ref", () => {
    const cmd = buildLaunchCommand("new-branch", repo, local("main"), "my-feature");
    expect(cmd).toBe(
      "{ git worktree add /tmp/proj/csm-my-feature -b my-feature --end-of-options main 2>/dev/null" +
      " || git worktree add /tmp/proj/csm-my-feature my-feature; }" +
      " && cd /tmp/proj/csm-my-feature && claude",
    );
  });

  test("new-branch remote: fetch prefix + origin/<name> base", () => {
    const cmd = buildLaunchCommand("new-branch", repo, remote("main"), "my-feature");
    expect(cmd).toContain("git fetch origin --end-of-options main && ");
    expect(cmd).toContain("-b my-feature --end-of-options origin/main 2>/dev/null");
  });

  test("checkout local: --end-of-options guards the ref", () => {
    expect(buildLaunchCommand("checkout", repo, local("feature"), "")).toBe(
      "git checkout --end-of-options feature && claude",
    );
  });

  test("checkout remote: track-or-fallback, both refs hardened where possible", () => {
    const cmd = buildLaunchCommand("checkout", repo, remote("feature"), "");
    expect(cmd).toContain("git fetch origin --end-of-options feature && ");
    expect(cmd).toContain("git checkout -b feature --track origin/feature 2>/dev/null || git checkout --end-of-options feature");
  });
});
