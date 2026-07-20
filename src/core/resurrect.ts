/**
 * Directory decisions behind `csm save-sessions` / `csm restore-sessions`.
 *
 * tmux-resurrect brings panes back in whatever directory the shell starts in, which for a
 * restored pane is often `$HOME`. Resuming a session there roots Claude at `$HOME`, and since
 * a session's repo is derived from its pane cwd it then files under `~` instead of its real
 * repo — and the next save snapshots `$HOME` as its cwd, making the damage permanent. These
 * two helpers keep that from happening and are kept free of tmux so they can be unit-tested.
 */

import { homedir } from "os";
import { getBaseRepoPath } from "./git";
import { recoverWorktreeTranscript, isDirectory } from "./recover";
import { resolveTranscriptPath, latestTranscriptCwd } from "./last-turn";

/**
 * The cwd `save-sessions` should record for a session, given the pane's current cwd and
 * whatever cwd the previous map already held for that same session.
 *
 * The rule is one-way: a real repo cwd already on record is never replaced by `$HOME`. A pane
 * sitting in `$HOME` is nearly always a restored pane that never got its directory back, and
 * overwriting a good path with it is what makes the misgrouping self-perpetuating. The cost is
 * that a session deliberately moved to `$HOME` keeps its old entry until it's deleted by hand
 * — the far cheaper of the two failure modes.
 */
export function pickSavedCwd(
  paneCwd: string,
  previousCwd: string | undefined,
  home: string = homedir(),
): string {
  if (paneCwd === home && previousCwd && previousCwd !== home) return previousCwd;
  return paneCwd;
}

/**
 * The directory to `cd` into before resuming a saved session, or null for "resume where the
 * pane already is" (the pre-existing behaviour, so an unresolvable entry never regresses).
 *
 * Branch order matters, and the `$HOME` case has to come first: `$HOME` is always a live
 * directory, so a generic exists-check would shadow it and strand exactly the poisoned entries
 * this exists to repair. Keeping it first also means `$HOME` never reaches `getBaseRepoPath`,
 * whose deleted-worktree fallback would otherwise scan `/Users` for a sibling whose name is a
 * hyphen-prefix of the home dir's basename.
 */
export async function resolveRestoreTarget(
  sessionId: string,
  savedCwd: string,
  home: string = homedir(),
  projectsDir?: string,
): Promise<string | null> {
  // 1. Poisoned entry — recover the real directory from what Claude itself last recorded.
  if (savedCwd === home) {
    const cwd = await transcriptCwd(sessionId, projectsDir);
    return cwd && cwd !== home && (await isDirectory(cwd)) ? cwd : null;
  }

  // 2. The common case: the saved directory is still there.
  if (await isDirectory(savedCwd)) return savedCwd;

  // 3. Gone — usually a deleted worktree. Resume in its base repo, consolidating the transcript
  //    into the base project folder first so the resumed session isn't tailing a frozen copy.
  const baseRepoPath = await getBaseRepoPath(savedCwd);
  if (baseRepoPath === savedCwd || !(await isDirectory(baseRepoPath))) return null;
  return recoverWorktreeTranscript(sessionId, savedCwd, baseRepoPath, projectsDir);
}

/** Claude's own last-recorded cwd for a session (tracks `/cd`), or null. */
async function transcriptCwd(sessionId: string, projectsDir?: string): Promise<string | null> {
  const transcript = await resolveTranscriptPath(sessionId, projectsDir);
  return transcript ? latestTranscriptCwd(transcript) : null;
}
