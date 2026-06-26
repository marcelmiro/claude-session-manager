/**
 * Redirect CSM's home root to a throwaway temp dir BEFORE any module that reads it
 * loads.
 *
 * `config.ts` computes `PATHS.dir` (and `hook-events.ts`'s `EVENTS_DIR`,
 * `approval.ts`'s `PENDING_DIR`/`DECISIONS_DIR`) once, at import time, from
 * `process.env.CSM_HOME ?? os.homedir()`. So this side-effect import MUST be the
 * first import in any test file that exercises those paths, so `CSM_HOME` is
 * already set when those constants are frozen. The path is a fixed deterministic
 * location (NOT mkdtemp) so every test file that loads `config` agrees on the same
 * `PATHS.dir` regardless of which one bun evaluates first.
 *
 * We can't override `os.homedir()` directly: bun resolves it from the startup
 * environment and ignores a runtime-set `$HOME` — hence the `CSM_HOME` seam.
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_HOME = join(tmpdir(), "csm-test-home");

process.env.CSM_HOME = TEST_HOME;
mkdirSync(TEST_HOME, { recursive: true });

/** `~/.config/csm` under the redirected home (matches `PATHS.dir`). */
export const CSM_DIR = join(TEST_HOME, ".config", "csm");
