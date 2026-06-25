/**
 * Synchronous fixture loader for the contract test suite.
 *
 * Sync (not async) on purpose: `detectStatus` and friends are synchronous and
 * must not be handed a `Promise`. No tmux/claude dependency — fixtures are the
 * pinned Gate A captures under `test/fixtures/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

/** Raw file text of a fixture under `test/fixtures/`. */
export function fixture(rel: string): string {
  return readFileSync(join(FIXTURES_DIR, rel), "utf8");
}

/** Parsed JSON of a fixture under `test/fixtures/`. */
export function fixtureJson(rel: string): unknown {
  return JSON.parse(fixture(rel));
}
