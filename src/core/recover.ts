import { homedir } from "os";
import { dirname } from "path";
import { mkdir, rename, rm, stat } from "fs/promises";
import { Glob } from "bun";
import type { SessionIndex } from "../types";

const DEFAULT_PROJECTS_DIR = `${homedir()}/.claude/projects`;

/** Encode an absolute path to Claude Code's project-folder name (every "/" → "-"). */
function encodeProjectDir(absPath: string): string {
  return absPath.replace(/\//g, "-");
}

/** True iff `path` exists and is a directory (guarded). */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

type TranscriptCopy = { path: string; dir: string; mtime: number; size: number };

/** Every `<id>.jsonl` under `projectsDir`, one per project folder the session's cwd ever hit. */
async function findTranscriptCopies(
  sessionId: string,
  projectsDir: string,
): Promise<TranscriptCopy[]> {
  const copies: TranscriptCopy[] = [];
  try {
    for await (const match of new Glob(`*/${sessionId}.jsonl`).scan({ cwd: projectsDir })) {
      const path = `${projectsDir}/${match}`;
      try {
        const st = await stat(path);
        copies.push({ path, dir: dirname(path), mtime: st.mtimeMs, size: st.size });
      } catch {
        // vanished between scan and stat — skip
      }
    }
  } catch {
    // missing projects dir or scan failure — no copies
  }
  return copies;
}

/**
 * Consolidate a session's transcript into its base repo's project folder and hand back the
 * directory to resume `claude` in.
 *
 * Claude Code keys each transcript's project folder off the *cwd* it runs in
 * (`~/.claude/projects/<cwd with "/" → "-">`) and resolves `--resume=<id>` only within the
 * current cwd's folder. Two things follow: a session whose git worktree was deleted can't be
 * resumed from the base repo (its `<id>.jsonl` still sits under the gone worktree's folder),
 * and a session whose cwd *moved* (worktree → base) can leave the SAME id as a `<id>.jsonl` in
 * BOTH folders. Duplicates are the bug behind "the phone sends but nothing comes back": the
 * send lands in the live pane while readers (transcript, mark-read) tail a frozen copy.
 *
 * This makes the base repo's folder the single source of truth: the newest copy (the live
 * conversation) wins and is moved into the base folder, its index entry is migrated, and every
 * older copy — plus its index entry — is removed. A copy larger than the one we keep is left
 * untouched (a divergence we won't silently discard). A live worktree still on disk resumes in
 * place, untouched. Idempotent: once consolidated, a second call is a no-op.
 */
export async function recoverWorktreeTranscript(
  sessionId: string,
  worktreeProjectPath: string,
  baseRepoPath: string,
  projectsDir: string = DEFAULT_PROJECTS_DIR,
): Promise<string> {
  // A live worktree still on disk resumes in place — never relocate an active worktree session.
  if (
    worktreeProjectPath &&
    worktreeProjectPath !== baseRepoPath &&
    (await isDirectory(worktreeProjectPath))
  ) {
    return worktreeProjectPath;
  }

  const baseDir = `${projectsDir}/${encodeProjectDir(baseRepoPath)}`;
  const baseFile = `${baseDir}/${sessionId}.jsonl`;
  const copies = await findTranscriptCopies(sessionId, projectsDir);

  // No transcript recorded anywhere → resume in base; a genuine miss surfaces upstream as before.
  if (copies.length === 0) return baseRepoPath;

  // Newest = the live conversation (a relocated copy is a superset of the copy it grew from).
  const newest = copies.reduce((a, b) => (b.mtime > a.mtime ? b : a));

  await mkdir(baseDir, { recursive: true });
  if (newest.path !== baseFile) {
    // Promote the live copy into the base folder. If an older base file exists it's superseded,
    // so overwriting it is safe (and the newest can't be smaller — it descends from it).
    await rename(newest.path, baseFile);
    await migrateIndexEntry(sessionId, newest.dir, baseDir, baseRepoPath, baseFile).catch(() => {});
  }

  // Drop every other (older) copy + its index entry. `baseFile` now holds the live conversation
  // and supersedes them. Guard: never delete a copy larger than what we keep — that would be a
  // divergent branch, not a stale leftover, and losing it silently is unacceptable.
  const keptSize = (await stat(baseFile)).size;
  for (const c of copies) {
    if (c.path === newest.path || c.path === baseFile) continue;
    if (c.size > keptSize) continue;
    await rm(c.path, { force: true }).catch(() => {});
    await removeIndexEntry(sessionId, c.dir).catch(() => {});
  }

  return baseRepoPath;
}

/** Move one session's entry from the source index into the base repo's index. */
async function migrateIndexEntry(
  sessionId: string,
  srcDir: string,
  destDir: string,
  baseRepoPath: string,
  destFile: string,
): Promise<void> {
  const srcIndexPath = `${srcDir}/sessions-index.json`;
  const srcRaw = await Bun.file(srcIndexPath).text().catch(() => null);
  if (!srcRaw) return;

  const srcIndex = JSON.parse(srcRaw) as SessionIndex;
  const idx = srcIndex.entries.findIndex((e) => e.sessionId === sessionId);
  if (idx === -1) return;

  const [entry] = srcIndex.entries.splice(idx, 1);
  entry.projectPath = baseRepoPath;
  entry.fullPath = destFile;
  await Bun.write(srcIndexPath, JSON.stringify(srcIndex));

  const destIndexPath = `${destDir}/sessions-index.json`;
  const destRaw = await Bun.file(destIndexPath).text().catch(() => null);
  const destIndex: SessionIndex = destRaw
    ? (JSON.parse(destRaw) as SessionIndex)
    : { version: srcIndex.version, entries: [] };
  if (!destIndex.entries.some((e) => e.sessionId === sessionId)) {
    destIndex.entries.push(entry);
  }
  await Bun.write(destIndexPath, JSON.stringify(destIndex));
}

/** Drop a session's entry from one project folder's index (best-effort). */
async function removeIndexEntry(sessionId: string, dir: string): Promise<void> {
  const indexPath = `${dir}/sessions-index.json`;
  const raw = await Bun.file(indexPath).text().catch(() => null);
  if (!raw) return;

  const index = JSON.parse(raw) as SessionIndex;
  const kept = index.entries.filter((e) => e.sessionId !== sessionId);
  if (kept.length !== index.entries.length) {
    index.entries = kept;
    await Bun.write(indexPath, JSON.stringify(index));
  }
}
