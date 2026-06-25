/**
 * Verification-gate guard.
 *
 * Reads the canonical machine state in `verification.json` and fails for any
 * gate with `enforce: true` whose `status !== "verified"`. This keeps `bun test`
 * honest: an enforced gate cannot be left unverified without the suite going red.
 *
 * Lives beside the `verification.json` it guards (per doc 04's Hard-enforcement
 * spec), not in `test/`. `bun test` finds it via glob.
 */

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Gate {
  title: string;
  status: string;
  enforce: boolean;
}

const verification = JSON.parse(
  readFileSync(join(import.meta.dir, "verification.json"), "utf8"),
) as { gates: Record<string, Gate> };

for (const [id, gate] of Object.entries(verification.gates)) {
  if (!gate.enforce) continue;
  test(`enforced gate ${id} (${gate.title}) is verified`, () => {
    if (gate.status !== "verified") {
      throw new Error(
        `Gate ${id} "${gate.title}" is enforced but status is "${gate.status}" ` +
          `(expected "verified"). See docs/plans/iphone-sessions/04-verification-gates.md.`,
      );
    }
    expect(gate.status).toBe("verified");
  });
}
