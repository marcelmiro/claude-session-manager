import { expect, test, beforeAll, afterAll } from "bun:test";
import { realpathSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileDiff, safeRepoPath, changedFiles, baseRef } from "./repo-files";

// --- safeRepoPath: the containment guard the /diff, /changes routes lean on ---

let guardRoot: string;
beforeAll(() => {
  guardRoot = realpathSync(mkdtempSync(`${tmpdir()}/rf-guard-`));
  mkdirSync(`${guardRoot}/src`);
  writeFileSync(`${guardRoot}/src/app.ts`, "ok");
  writeFileSync(`${guardRoot}/.env`, "SECRET=1");
  symlinkSync("/etc/passwd", `${guardRoot}/escape`); // symlink FILE out of repo
  symlinkSync("/etc", `${guardRoot}/etcdir`); // symlink DIR out of repo
});
afterAll(() => rmSync(guardRoot, { recursive: true, force: true }));

test("in-repo file is allowed", () => {
  expect(safeRepoPath(guardRoot, "src/app.ts")).toBe(`${guardRoot}/src/app.ts`);
});
test("in-repo dotfile (.env) is allowed — conscious tradeoff, own machine", () => {
  expect(safeRepoPath(guardRoot, ".env")).toBe(`${guardRoot}/.env`);
});
test("../ traversal is rejected", () => {
  expect(safeRepoPath(guardRoot, "../../../etc/passwd")).toBeNull();
});
test("absolute path outside repo is rejected", () => {
  expect(safeRepoPath(guardRoot, "/etc/passwd")).toBeNull();
});
test("dotdot that normalizes back inside is allowed", () => {
  expect(safeRepoPath(guardRoot, "src/../src/app.ts")).toBe(`${guardRoot}/src/app.ts`);
});
test("symlink FILE escaping the repo is rejected", () => {
  expect(safeRepoPath(guardRoot, "escape")).toBeNull();
});
test("path THROUGH a symlinked dir escaping the repo is rejected", () => {
  expect(safeRepoPath(guardRoot, "etcdir/passwd")).toBeNull();
});
test("non-existent target INSIDE root is allowed (deleted/renamed file)", () => {
  expect(safeRepoPath(guardRoot, "src/gone.ts")).toBe(`${guardRoot}/src/gone.ts`);
});

// --- fileDiff / repoTree / readRepoFile on a throwaway repo ---

async function tempRepo(): Promise<string> {
  const root = realpathSync(mkdtempSync(`${tmpdir()}/rf-repo-`));
  await Bun.$`git -C ${root} init -q`.quiet();
  await Bun.$`git -C ${root} config user.email t@t.t`.quiet();
  await Bun.$`git -C ${root} config user.name t`.quiet();
  return root;
}

test("modified tracked file yields adds AND dels", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "one\ntwo\nthree\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/a.txt`, "one\nCHANGED\nthree\nfour\n");
  const d = await fileDiff(root, `${root}/a.txt`, "a.txt");
  expect(d.add).toBeGreaterThan(0);
  expect(d.del).toBeGreaterThan(0);
  expect(d.patch).toContain("CHANGED");
  expect(d.status).toBe("M");
  rmSync(root, { recursive: true, force: true });
});

test("untracked file renders as all-additions", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/seed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/new.txt`, "alpha\nbeta\n");
  const d = await fileDiff(root, `${root}/new.txt`, "new.txt");
  expect(d.add).toBe(2);
  expect(d.del).toBe(0);
  expect(d.status).toBe("A");
  expect(d.empty).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

test("deleted tracked file reports status D", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/gone.txt`, "one\ntwo\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  rmSync(`${root}/gone.txt`);
  const d = await fileDiff(root, `${root}/gone.txt`, "gone.txt");
  expect(d.status).toBe("D");
  expect(d.del).toBeGreaterThan(0);
  rmSync(root, { recursive: true, force: true });
});

test("unchanged tracked file is empty (no whole-file re-diff)", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "stable\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  const d = await fileDiff(root, `${root}/a.txt`, "a.txt");
  expect(d.empty).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("binary file is flagged, not shipped", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/seed.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm init`.quiet();
  writeFileSync(`${root}/img.bin`, Buffer.from([0, 1, 2, 0, 255, 3]));
  const d = await fileDiff(root, `${root}/img.bin`, "img.bin");
  expect(d.binary).toBe(true);
  expect(d.patch).toBeUndefined();
  rmSync(root, { recursive: true, force: true });
});

test("unborn HEAD (no commits) diffs against empty tree without throwing", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/first.txt`, "hello\n");
  await Bun.$`git -C ${root} add -A`.quiet(); // staged but never committed
  const d = await fileDiff(root, `${root}/first.txt`, "first.txt");
  expect(d.add).toBe(1);
  expect(d.patch).toContain("hello");
  rmSync(root, { recursive: true, force: true });
});

// --- baseRef + changedFiles: the "PR view" (branch vs base, committed + uncommitted) ---

test("baseRef picks the default branch; changedFiles shows committed + uncommitted + untracked", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/base.txt`, "one\n");
  writeFileSync(`${root}/keep.txt`, "keep\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm base`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet(); // deterministic default branch
  // Feature branch: a committed new file + a committed modification to a tracked file.
  await Bun.$`git -C ${root} checkout -q -b feature`.quiet();
  writeFileSync(`${root}/committed.txt`, "added on branch\n");
  writeFileSync(`${root}/base.txt`, "one\ntwo\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm feat`.quiet();
  // An uncommitted working-tree edit + an untracked new file.
  writeFileSync(`${root}/keep.txt`, "keep\nCHANGED\n");
  writeFileSync(`${root}/untracked.txt`, "u\n");

  const { ref, label } = await baseRef(root);
  expect(label).toBe("main"); // no origin → falls back to local main
  const files = await changedFiles(root, ref);
  const paths = files.map((f) => f.path).sort();
  // committed-new + committed-modify + uncommitted + untracked all appear vs the base.
  expect(paths).toEqual(["base.txt", "committed.txt", "keep.txt", "untracked.txt"]);
  // status letters vs base: new files A, modified M.
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.status]));
  expect(byPath["committed.txt"]).toBe("A");
  expect(byPath["untracked.txt"]).toBe("A");
  expect(byPath["base.txt"]).toBe("M");
  expect(byPath["keep.txt"]).toBe("M");
  rmSync(root, { recursive: true, force: true });
});

test("changedFiles: on the default branch with no divergence → only uncommitted show", async () => {
  const root = await tempRepo();
  writeFileSync(`${root}/a.txt`, "x\n");
  await Bun.$`git -C ${root} add -A`.quiet();
  await Bun.$`git -C ${root} commit -qm base`.quiet();
  await Bun.$`git -C ${root} branch -M main`.quiet();
  writeFileSync(`${root}/a.txt`, "x\ny\n"); // uncommitted only
  const { ref } = await baseRef(root); // merge-base(HEAD, main) == HEAD
  const paths = (await changedFiles(root, ref)).map((f) => f.path);
  expect(paths).toEqual(["a.txt"]);
  rmSync(root, { recursive: true, force: true });
});
