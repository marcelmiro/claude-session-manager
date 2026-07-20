import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { pickSavedCwd, resolveRestoreTarget } from "./resurrect";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function enc(p: string): string {
  return p.replace(/\//g, "-");
}

let root: string; // stands in for the home dir in these tests
let projectsDir: string;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/csm-resurrect-`);
  projectsDir = `${root}/projects`;
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Write a transcript for SID whose last record carries `cwd`. */
async function seedTranscript(cwd: string): Promise<void> {
  const dir = `${projectsDir}/${enc(cwd)}`;
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${SID}.jsonl`, `{"type":"user","cwd":${JSON.stringify(cwd)}}\n`);
}

// --- pickSavedCwd -----------------------------------------------------------

test("pickSavedCwd keeps a recorded repo cwd when the pane reports home", () => {
  expect(pickSavedCwd("/home/dev", "/home/dev/repo", "/home/dev")).toBe("/home/dev/repo");
});

test("pickSavedCwd takes the pane cwd when it is a real directory", () => {
  expect(pickSavedCwd("/home/dev/repo", "/home/dev/other", "/home/dev")).toBe("/home/dev/repo");
});

test("pickSavedCwd records home when nothing better is on record", () => {
  expect(pickSavedCwd("/home/dev", undefined, "/home/dev")).toBe("/home/dev");
  expect(pickSavedCwd("/home/dev", "/home/dev", "/home/dev")).toBe("/home/dev");
});

// --- resolveRestoreTarget ---------------------------------------------------

test("returns the saved dir when it still exists", async () => {
  const repo = `${root}/repo`;
  await mkdir(repo);
  expect(await resolveRestoreTarget(SID, repo, root, projectsDir)).toBe(repo);
});

test("a home saved cwd resolves to the transcript's cwd, never to home", async () => {
  const repo = `${root}/repo`;
  await mkdir(repo);
  await seedTranscript(repo);
  // `root` exists as a directory, so an exists-first branch order would wrongly return it.
  expect(await resolveRestoreTarget(SID, root, root, projectsDir)).toBe(repo);
});

test("a home saved cwd with no usable transcript resolves to null (bare resume)", async () => {
  expect(await resolveRestoreTarget(SID, root, root, projectsDir)).toBeNull();
  await seedTranscript(`${root}/gone`); // recorded cwd no longer on disk
  expect(await resolveRestoreTarget(SID, root, root, projectsDir)).toBeNull();
});

test("a deleted worktree resolves to its base repo", async () => {
  const base = `${root}/repo`;
  await mkdir(`${base}/.git`, { recursive: true });
  await writeFile(`${base}/.git/HEAD`, "ref: refs/heads/main\n");
  const worktree = `${root}/repo-feature`; // never created — stands for a deleted worktree
  expect(await resolveRestoreTarget(SID, worktree, root, projectsDir)).toBe(base);
});

test("an unresolvable saved cwd returns null", async () => {
  expect(await resolveRestoreTarget(SID, `${root}/nope`, root, projectsDir)).toBeNull();
});
