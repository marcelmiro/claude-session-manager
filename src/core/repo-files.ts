/**
 * Repo-scoped, read-only diff access for the mobile bridge (Portkey Layer 1). Backs the
 * `/changes` and `/diff` routes, containment-guarded to the session's repo root. Diffs use a
 * "PR view" baseline — the merge-base with the repo's default branch — so a branch's COMMITTED
 * work shows, not just uncommitted edits. Every `git` call uses `.nothrow().quiet()` and
 * branches on `exitCode`: `git diff --no-index` returns non-zero WHEN A DIFF EXISTS, which
 * `Bun.$` would otherwise throw on.
 */

import { statSync, realpathSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { resolveSessionPane } from "./session-api";
import { listPanes } from "./tmux";

// git's empty-tree object — diff target for an unborn HEAD (repo with no commits).
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Ship at most this much per file: a lockfile/minified diff or huge blob isn't worth
// pushing whole over Tailscale to a phone.
const SIZE_CAP = 512 * 1024;

export interface FileDiff {
  branch: string;
  base: string; // default-branch name diffed against ("" when falling back to HEAD/empty)
  status?: string; // single-letter status vs base: A(dded) / M(odified) / D(eleted). Absent when empty.
  add: number;
  del: number;
  patch?: string;
  binary?: boolean;
  tooLarge?: boolean;
  empty?: boolean;
}

/** Resolve a session's live repo root: pane cwd → `git rev-parse --show-toplevel`. */
export async function repoRootForSession(sessionId: string): Promise<string | null> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return null;
  const pane = (await listPanes()).find((p) => p.paneId === paneId);
  const cwd = pane?.currentPath;
  if (!cwd) return null;
  const r = await Bun.$`git -C ${cwd} rev-parse --show-toplevel`.nothrow().quiet();
  if (r.exitCode !== 0) return null;
  const root = r.stdout.toString().trim();
  if (!root) return null;
  // Canonicalize so paths from `safeRepoPath` (which realpaths the root) are relative to the
  // same base — otherwise a symlinked repo path (e.g. /tmp → /private/tmp) desyncs the two.
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

/**
 * Containment guard: resolve `rel` under `root` and require the result to stay inside the
 * repo. Tolerates a non-existent target (deleted/renamed files must still validate) by
 * realpath-ing the DEEPEST EXISTING ANCESTOR — the non-existent tail can't hold a symlink,
 * so this stays safe against `../`, absolute paths, and symlink escapes. Returns the
 * resolved absolute path, or null if it escapes.
 */
export function safeRepoPath(root: string, rel: string): string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const abs = resolve(realRoot, rel);
  // Walk up to the deepest ancestor that exists on disk, realpath it (resolves any symlink
  // in the existing prefix), then re-attach the non-existent tail.
  let existing = abs;
  const tail: string[] = [];
  // Guard against an unbounded loop on a malformed path — dirname eventually fixes at "/".
  while (existing !== dirname(existing)) {
    try {
      existing = realpathSync(existing);
      break;
    } catch {
      tail.unshift(existing.slice(dirname(existing).length + 1));
      existing = dirname(existing);
    }
  }
  const real = tail.length ? resolve(existing, ...tail) : existing;
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  return real;
}

/** Current branch (empty on detached HEAD). */
async function currentBranch(root: string): Promise<string> {
  const r = await Bun.$`git -C ${root} branch --show-current`.nothrow().quiet();
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

/** Parse `--numstat` output: `add\tdel\tpath`, with `-\t-` marking a binary file. */
function parseNumstat(out: string): { add: number; del: number; binary: boolean } {
  const line = out.trim().split("\n").filter(Boolean)[0];
  if (!line) return { add: 0, del: 0, binary: false };
  const [a, d] = line.split("\t");
  if (a === "-" && d === "-") return { add: 0, del: 0, binary: true };
  return { add: Number(a) || 0, del: Number(d) || 0, binary: false };
}

/**
 * The commit to diff a branch against for a "PR view": the merge-base of HEAD and the repo's
 * default branch (origin/HEAD → origin/main, else a local main/master). Diffing from here to
 * the working tree captures the branch's committed AND uncommitted changes. Falls back to the
 * empty tree (unborn HEAD) or HEAD itself (no discoverable base → uncommitted-only). `label`
 * is the short base-branch name for the UI ("" when falling back to HEAD/empty).
 */
export async function baseRef(root: string): Promise<{ ref: string; label: string }> {
  const headOk =
    (await Bun.$`git -C ${root} rev-parse --verify HEAD`.nothrow().quiet()).exitCode === 0;
  if (!headOk) return { ref: EMPTY_TREE, label: "" };
  let def = "";
  const sym = await Bun.$`git -C ${root} symbolic-ref --quiet refs/remotes/origin/HEAD`
    .nothrow()
    .quiet();
  if (sym.exitCode === 0) {
    def = sym.stdout.toString().trim().replace(/^refs\/remotes\//, ""); // e.g. "origin/main"
  } else {
    for (const cand of ["origin/main", "origin/master", "main", "master"]) {
      if (
        (await Bun.$`git -C ${root} rev-parse --verify --quiet ${cand}`.nothrow().quiet())
          .exitCode === 0
      ) {
        def = cand;
        break;
      }
    }
  }
  if (!def) return { ref: "HEAD", label: "" }; // no base branch → uncommitted-only
  const mb = await Bun.$`git -C ${root} merge-base HEAD ${def}`.nothrow().quiet();
  if (mb.exitCode !== 0) return { ref: "HEAD", label: "" };
  return { ref: mb.stdout.toString().trim(), label: def.replace(/^origin\//, "") };
}

/**
 * Diff for one file: branch vs its base (committed + uncommitted). Handles: unborn HEAD /
 * no-base (falls back to empty-tree / HEAD via `baseRef`), untracked new files (fall back to
 * `--no-index` vs `/dev/null` so they render as all-additions), binary files, and an oversized
 * patch. `--no-renames` keeps paths literal so numstat parses cleanly. `abs` is the
 * pre-validated absolute path (from `safeRepoPath`); `rel` is repo-relative.
 */
export async function fileDiff(root: string, abs: string, rel: string): Promise<FileDiff> {
  const branch = await currentBranch(root);
  const { ref, label } = await baseRef(root);

  let patch = (
    await Bun.$`git -C ${root} diff --no-renames ${ref} -- ${rel}`.nothrow().quiet()
  ).stdout.toString();
  let numstat = (
    await Bun.$`git -C ${root} diff --no-renames --numstat ${ref} -- ${rel}`.nothrow().quiet()
  ).stdout.toString();

  // Empty patch is ambiguous: unchanged, OR an untracked new file (never in `git diff <ref>`).
  // Only the latter gets the `--no-index` vs /dev/null fallback (renders as all-additions).
  // Exit 1 = has-diff, not an error (hence `.nothrow()`).
  const untracked =
    !patch.trim() &&
    (await Bun.$`git -C ${root} ls-files --others --exclude-standard -- ${rel}`.nothrow().quiet())
      .stdout.toString()
      .trim() !== "";
  if (untracked) {
    patch = (
      await Bun.$`git -C ${root} diff --no-index --no-renames -- /dev/null ${abs}`.nothrow().quiet()
    ).stdout.toString();
    numstat = (
      await Bun.$`git -C ${root} diff --no-index --numstat --no-renames -- /dev/null ${abs}`
        .nothrow()
        .quiet()
    ).stdout.toString();
  }

  if (!patch.trim()) return { branch, base: label, add: 0, del: 0, empty: true };
  // Status letter from the patch's file header (`--no-renames`, so renames split into D+A):
  // an untracked or "new file mode" is Added, "deleted file mode" is Deleted, else Modified.
  const status = untracked || /^new file mode/m.test(patch) ? "A" : /^deleted file mode/m.test(patch) ? "D" : "M";
  const { add, del, binary } = parseNumstat(numstat);
  if (binary) return { branch, base: label, status, add, del, binary: true };
  if (patch.length > SIZE_CAP) return { branch, base: label, status, add, del, tooLarge: true };
  return { branch, base: label, status, add, del, patch };
}

export interface ChangedFile {
  path: string;
  status: string; // git single-letter status vs base: A(dded) / M(odified) / D(eleted) / T(ype)
  add: number;
  del: number;
  binary: boolean;
}

/**
 * Every file changed from `ref` to the working tree (committed on the branch + uncommitted),
 * plus untracked new files as all-additions. Each carries a `--name-status` letter (A/M/D)
 * relative to the base — consistent with the diff (NOT `git status --porcelain`, which would
 * be blank for committed branch files). `--no-renames` keeps paths literal (renames = D + A)
 * so numstat/status parse cleanly. Deduped by path.
 */
export async function changedFiles(root: string, ref: string): Promise<ChangedFile[]> {
  const [numstatR, statusR] = await Promise.all([
    Bun.$`git -C ${root} diff --no-renames --numstat ${ref}`.nothrow().quiet(),
    Bun.$`git -C ${root} diff --no-renames --name-status ${ref}`.nothrow().quiet(),
  ]);
  const statusByPath = new Map<string, string>();
  for (const line of statusR.stdout.toString().trim().split("\n").filter(Boolean)) {
    const [st, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (path) statusByPath.set(path, st![0] || "M");
  }
  const map = new Map<string, ChangedFile>();
  for (const line of numstatR.stdout.toString().trim().split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const binary = a === "-" && d === "-";
    map.set(path, {
      path,
      status: statusByPath.get(path) || "M",
      add: binary ? 0 : Number(a) || 0,
      del: binary ? 0 : Number(d) || 0,
      binary,
    });
  }
  // Untracked new files aren't in `git diff <ref>`; add them as all-additions (status A).
  const untracked = (
    await Bun.$`git -C ${root} ls-files --others --exclude-standard`.nothrow().quiet()
  ).stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
  await Promise.all(
    untracked.map(async (path) => {
      if (map.has(path)) return;
      const ns = (
        await Bun.$`git -C ${root} diff --no-index --numstat --no-renames -- /dev/null ${`${root}/${path}`}`
          .nothrow()
          .quiet()
      ).stdout.toString();
      const { add, del, binary } = parseNumstat(ns);
      map.set(path, { path, status: "A", add, del, binary });
    }),
  );
  return [...map.values()];
}

/**
 * The files this branch changed vs its base — the "PR view" (committed + uncommitted). Uses
 * `baseRef` (merge-base with the default branch), so committed work shows, not just
 * working-tree edits. Ordered most-recently-modified first so the phone's card previews the
 * latest edits. `base` is the base-branch name for the UI. Null when the session has no live repo.
 */
export async function branchChanges(sessionId: string): Promise<{
  root: string;
  branch: string;
  base: string;
  files: ChangedFile[];
} | null> {
  const root = await repoRootForSession(sessionId);
  if (!root) return null;
  const { ref, label } = await baseRef(root);
  const files = await changedFiles(root, ref);
  const withMtime = files.map((f) => {
    let mtime = 0;
    try {
      mtime = statSync(`${root}/${f.path}`).mtimeMs; // deleted files sort last (mtime 0)
    } catch {}
    return { f, mtime };
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return { root, branch: await currentBranch(root), base: label, files: withMtime.map((x) => x.f) };
}
