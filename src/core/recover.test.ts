import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "fs/promises";
import { tmpdir } from "os";
import { recoverWorktreeTranscript } from "./recover";
import type { SessionIndex } from "../types";

const SID = "11111111-2222-3333-4444-555555555555";
const BASE = "/Users/dev/Documents/repo";
const WORKTREE = "/Users/dev/Documents/repo-feature";

function enc(p: string): string {
  return p.replace(/\//g, "-");
}

let projectsDir: string;

beforeEach(async () => {
  projectsDir = await mkdtemp(`${tmpdir()}/csm-recover-`);
});

afterEach(async () => {
  await rm(projectsDir, { recursive: true, force: true });
});

/** Seed a worktree project folder with one session's jsonl + index entry. */
async function seedWorktree(): Promise<{ srcDir: string; srcFile: string }> {
  const srcDir = `${projectsDir}/${enc(WORKTREE)}`;
  await mkdir(srcDir, { recursive: true });
  const srcFile = `${srcDir}/${SID}.jsonl`;
  await writeFile(srcFile, `{"cwd":"${WORKTREE}"}\n`);
  const index: SessionIndex = {
    version: 1,
    entries: [
      {
        sessionId: SID,
        fullPath: srcFile,
        fileMtime: 0,
        firstPrompt: "hi",
        summary: "",
        messageCount: 1,
        created: "2026-07-10T00:00:00Z",
        modified: "2026-07-10T00:00:00Z",
        gitBranch: "feature",
        projectPath: WORKTREE,
        isSidechain: false,
      },
    ],
  };
  await writeFile(`${srcDir}/sessions-index.json`, JSON.stringify(index));
  return { srcDir, srcFile };
}

test("relocates transcript + index entry to base repo when worktree is deleted", async () => {
  const { srcFile } = await seedWorktree(); // no worktree dir on disk → deleted

  const result = await recoverWorktreeTranscript(SID, WORKTREE, BASE, projectsDir);
  expect(result).toBe(BASE);

  const destDir = `${projectsDir}/${enc(BASE)}`;
  const destFile = `${destDir}/${SID}.jsonl`;
  expect(await Bun.file(destFile).exists()).toBe(true);
  expect(await Bun.file(srcFile).exists()).toBe(false);

  // Index entry migrated to base index with rewritten projectPath/fullPath.
  const destIndex = JSON.parse(await Bun.file(`${destDir}/sessions-index.json`).text()) as SessionIndex;
  const moved = destIndex.entries.find((e) => e.sessionId === SID);
  expect(moved?.projectPath).toBe(BASE);
  expect(moved?.fullPath).toBe(destFile);

  // Source index no longer references the session.
  const srcIndex = JSON.parse(
    await Bun.file(`${projectsDir}/${enc(WORKTREE)}/sessions-index.json`).text(),
  ) as SessionIndex;
  expect(srcIndex.entries.some((e) => e.sessionId === SID)).toBe(false);
});

test("is idempotent — second call still returns base and leaves file in place", async () => {
  await seedWorktree();
  await recoverWorktreeTranscript(SID, WORKTREE, BASE, projectsDir);
  const result = await recoverWorktreeTranscript(SID, WORKTREE, BASE, projectsDir);
  expect(result).toBe(BASE);

  const destFile = `${projectsDir}/${enc(BASE)}/${SID}.jsonl`;
  expect(await Bun.file(destFile).exists()).toBe(true);
});

test("no-op when the worktree directory still exists → resumes in place", async () => {
  await seedWorktree();
  const liveWorktree = `${projectsDir}/live-worktree`; // a real dir that exists
  await mkdir(liveWorktree, { recursive: true });

  // Point the encoded source folder at the live path so the jsonl is found there.
  const liveSrcDir = `${projectsDir}/${enc(liveWorktree)}`;
  await mkdir(liveSrcDir, { recursive: true });
  await writeFile(`${liveSrcDir}/${SID}.jsonl`, "{}\n");

  const result = await recoverWorktreeTranscript(SID, liveWorktree, BASE, projectsDir);
  expect(result).toBe(liveWorktree);
  expect(await Bun.file(`${liveSrcDir}/${SID}.jsonl`).exists()).toBe(true);
});

test("no-op for a non-worktree session (repoPath === baseRepoPath)", async () => {
  const result = await recoverWorktreeTranscript(SID, BASE, BASE, projectsDir);
  expect(result).toBe(BASE);
});

/** Seed a base-repo copy of the session (the live conversation after cwd moved to base). */
async function seedBase(content: string, mtimeSec: number): Promise<string> {
  const destDir = `${projectsDir}/${enc(BASE)}`;
  await mkdir(destDir, { recursive: true });
  const destFile = `${destDir}/${SID}.jsonl`;
  await writeFile(destFile, content);
  await utimes(destFile, mtimeSec, mtimeSec);
  return destFile;
}

test("consolidates duplicates: keeps the newest (base) copy, deletes the stale worktree copy", async () => {
  const { srcFile } = await seedWorktree(); // frozen worktree copy (deleted worktree)
  await utimes(srcFile, 1000, 1000); // older
  const live = "{}\n".repeat(50); // larger, superset-ish
  const destFile = await seedBase(live, 2000); // newer + bigger = the live conversation

  const result = await recoverWorktreeTranscript(SID, WORKTREE, BASE, projectsDir);
  expect(result).toBe(BASE);

  // Live base copy kept intact; stale worktree copy removed.
  expect(await Bun.file(destFile).exists()).toBe(true);
  expect(await Bun.file(destFile).text()).toBe(live);
  expect(await Bun.file(srcFile).exists()).toBe(false);

  // Worktree index no longer references the session.
  const srcIndex = JSON.parse(
    await Bun.file(`${projectsDir}/${enc(WORKTREE)}/sessions-index.json`).text(),
  ) as SessionIndex;
  expect(srcIndex.entries.some((e) => e.sessionId === SID)).toBe(false);
});

test("never clobbers a newer base copy with an older worktree copy", async () => {
  const { srcFile } = await seedWorktree();
  await utimes(srcFile, 1000, 1000);
  const live = '{"live":true}\n';
  const destFile = await seedBase(live, 2000);

  await recoverWorktreeTranscript(SID, WORKTREE, BASE, projectsDir);

  // Base content is the live one, not overwritten by the worktree copy.
  expect(await Bun.file(destFile).text()).toBe(live);
});

test("safety: does not delete a straggler larger than the kept copy", async () => {
  const { srcFile } = await seedWorktree();
  // Worktree copy is OLDER but LARGER (a possible divergence) → must be preserved, not discarded.
  await writeFile(srcFile, "x".repeat(500));
  await utimes(srcFile, 1000, 1000);
  const destFile = await seedBase("small\n", 2000); // newer but smaller = kept

  await recoverWorktreeTranscript(SID, WORKTREE, BASE, projectsDir);

  expect(await Bun.file(destFile).exists()).toBe(true);
  expect(await Bun.file(srcFile).exists()).toBe(true); // larger straggler left alone
});
