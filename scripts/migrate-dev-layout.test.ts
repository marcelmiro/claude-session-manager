import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, symlinkSync, writeFileSync, existsSync, readFileSync, readlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, encodeClaudeProjectPath, parseWorktreePorcelain, replacePathPrefix, rewritePaths } from "./migrate-dev-layout";

function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

describe("dev-layout migration path handling", () => {
  test("parses main, branches, and detached worktrees", () => {
    expect(parseWorktreePorcelain(`worktree /Users/throxy/Documents/csm\nHEAD abc\nbranch refs/heads/main\n\nworktree /Users/throxy/Documents/csm-feature\nHEAD def\nbranch refs/heads/feature/x\n\nworktree /tmp/detached\nHEAD 123\ndetached\n`)).toEqual([
      { path: "/Users/throxy/Documents/csm", branch: "main" },
      { path: "/Users/throxy/Documents/csm-feature", branch: "feature/x" },
      { path: "/tmp/detached", branch: null },
    ]);
  });

  test("only replaces a true path prefix", () => {
    expect(replacePathPrefix("/Users/throxy/dev/csm", "/Users/throxy", "/Users/marcel")).toBe("/Users/marcel/dev/csm");
    expect(replacePathPrefix("/Users/throxy-old/dev", "/Users/throxy", "/Users/marcel")).toBe("/Users/throxy-old/dev");
  });

  test("rewrites specific worktrees before their home prefix", () => {
    const mappings: Array<[string, string]> = [
      ["/Users/throxy/Documents/csm-feature", "/Users/marcel/dev/csm/.claude/worktrees/feature"],
      ["/Users/throxy", "/Users/marcel"],
    ];
    expect(rewritePaths("cwd=/Users/throxy/Documents/csm-feature", mappings)).toBe(
      "cwd=/Users/marcel/dev/csm/.claude/worktrees/feature",
    );
  });

  test("uses Claude's slash-to-dash project encoding", () => {
    expect(encodeClaudeProjectPath("/Users/marcel/dev/csm")).toBe("-Users-marcel-dev-csm");
  });

  test("applies a manifest after a simulated home rename and repairs the linked worktree", async () => {
    const root = mkdtempSync(`${realpathSync(tmpdir())}/csm-layout-`);
    const sourceHome = join(root, "old-user");
    const targetHome = join(root, "new-user");
    const sourceRoot = join(sourceHome, "Documents");
    const targetRoot = join(targetHome, "dev");
    const repo = join(sourceRoot, "repo");
    const worktree = join(sourceRoot, "repo-feature");
    mkdirSync(repo, { recursive: true });
    runGit(repo, "init", "-q", "-b", "main");
    runGit(repo, "config", "user.email", "test@example.com");
    runGit(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "README.md"), "test\n");
    runGit(repo, "add", "README.md");
    runGit(repo, "commit", "-qm", "init");
    runGit(repo, "branch", "feature");
    runGit(repo, "worktree", "add", "-q", worktree, "feature");

    const oldProjectName = encodeClaudeProjectPath(worktree);
    const oldProjectDir = join(sourceHome, ".claude", "projects", oldProjectName);
    mkdirSync(oldProjectDir, { recursive: true });
    writeFileSync(join(oldProjectDir, "session.jsonl"), `${JSON.stringify({ cwd: worktree })}\n`);
    mkdirSync(join(sourceHome, ".config", "csm", "migrations"), { recursive: true });
    writeFileSync(join(sourceHome, ".config", "csm", "config.json"), '{"repositories":{"roots":["~/Documents"]}}\n');
    mkdirSync(join(sourceHome, ".local", "bin"), { recursive: true });
    symlinkSync(join(repo, "bin", "tool"), join(sourceHome, ".local", "bin", "tool"));

    const manifest = await buildManifest({ sourceHome, targetHome, sourceRoot, targetRoot });
    expect(manifest.blockers).toEqual([]);
    const manifestRelative = join(".config", "csm", "migrations", "test-manifest.json");
    writeFileSync(join(sourceHome, manifestRelative), `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(sourceHome, targetHome); // what the OS account rename does to the home tree

    const script = join(import.meta.dir, "migrate-dev-layout.ts");
    const applied = Bun.spawnSync(["bun", "run", script, "apply", "--manifest", join(targetHome, manifestRelative)], {
      cwd: targetHome,
      env: { ...process.env, HOME: targetHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);

    const finalRepo = join(targetRoot, "repo");
    const finalWorktree = join(finalRepo, ".claude", "worktrees", "feature");
    expect(existsSync(finalRepo)).toBe(true);
    expect(existsSync(finalWorktree)).toBe(true);
    expect(runGit(finalWorktree, "rev-parse", "--show-toplevel").trim()).toBe(finalWorktree);
    expect(runGit(finalRepo, "worktree", "list", "--porcelain")).toContain(`worktree ${finalWorktree}`);
    expect(readFileSync(join(finalRepo, ".git", "info", "exclude"), "utf8")).toContain("/.claude/worktrees/");
    expect(readFileSync(join(targetHome, ".config", "csm", "config.json"), "utf8")).toContain('"~/dev"');

    const finalProjectDir = join(targetHome, ".claude", "projects", encodeClaudeProjectPath(finalWorktree));
    expect(readFileSync(join(finalProjectDir, "session.jsonl"), "utf8")).toContain(finalWorktree);
    expect(readlinkSync(join(targetHome, ".local", "bin", "tool"))).toBe(join(finalRepo, "bin", "tool"));
  });
});
