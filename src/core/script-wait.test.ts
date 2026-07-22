/**
 * ⏳ script-wait: prefix precedence and the persisted-verdict evaluation the
 * monitor relies on (fresh process per tick — nothing in-memory survives).
 */

import { test, expect } from "bun:test";
import { evaluateEntry, type ScriptWaitEntry } from "./script-wait";
import { desiredPrefix, stripAllPrefixes, ATTENTION_PREFIX, RUNNING_PREFIX, SCRIPT_PREFIX } from "./notifications";

// --- prefix helpers -------------------------------------------------------

test("desiredPrefix precedence: ⚡ > 🔄 > ⏳ > none", () => {
  expect(desiredPrefix(true, true, true)).toBe(ATTENTION_PREFIX);
  expect(desiredPrefix(false, true, true)).toBe(RUNNING_PREFIX);
  expect(desiredPrefix(false, false, true)).toBe(SCRIPT_PREFIX);
  expect(desiredPrefix(false, false, false)).toBe("");
  expect(desiredPrefix(false, false)).toBe("");
});

test("stripAllPrefixes strips ⏳ like the others", () => {
  expect(stripAllPrefixes("⏳csm/fix-auth")).toBe("csm/fix-auth");
  expect(stripAllPrefixes("⚡csm")).toBe("csm");
  expect(stripAllPrefixes("🔄csm")).toBe("csm");
  expect(stripAllPrefixes("csm")).toBe("csm");
});

// --- evaluateEntry --------------------------------------------------------

function entry(pending: ScriptWaitEntry["pending"], verdicts: ScriptWaitEntry["verdicts"] = {}): ScriptWaitEntry {
  return { size: 1, mtimeMs: 1, pending, verdicts };
}

const alive = async () => true;
const dead = async () => false;
const boom = async (): Promise<boolean> => {
  throw new Error("probe must not run");
};

test("no pending scripts → not waiting, no probe", async () => {
  const e = entry([]);
  expect(await evaluateEntry(e, 0, boom)).toEqual({ waiting: false, changed: false });
});

test("live runner → waiting, verdict recorded", async () => {
  const e = entry([{ key: "t1", outputPath: "/tmp/t1.output" }]);
  expect(await evaluateEntry(e, 1000, alive)).toEqual({ waiting: true, changed: true });
  expect(e.verdicts["t1"]).toEqual({ ts: 1000, alive: true });
});

test("dead runner → not waiting, and death is terminal (no re-probe ever)", async () => {
  const e = entry([{ key: "t1", outputPath: "/tmp/t1.output" }]);
  expect((await evaluateEntry(e, 1000, dead)).waiting).toBe(false);
  // Far past the TTL — a dead verdict must never probe again.
  expect(await evaluateEntry(e, 10_000_000, boom)).toEqual({ waiting: false, changed: false });
});

test("alive verdict is trusted within the TTL, re-probed after", async () => {
  const e = entry([{ key: "t1", outputPath: "/tmp/t1.output" }], { t1: { ts: 1000, alive: true } });
  // Inside TTL: cached, probe not called.
  expect(await evaluateEntry(e, 5000, boom)).toEqual({ waiting: true, changed: false });
  // Past TTL: re-probed — runner died in the meantime.
  expect((await evaluateEntry(e, 20_000, dead)).waiting).toBe(false);
  expect(e.verdicts["t1"]).toEqual({ ts: 20_000, alive: false });
});

test("unprobeable task (no outputPath) stays visible", async () => {
  const e = entry([{ key: "t1" }]);
  expect((await evaluateEntry(e, 0, boom)).waiting).toBe(true);
});

test("one live among dead is enough", async () => {
  const e = entry(
    [
      { key: "dead", outputPath: "/tmp/dead.output" },
      { key: "live", outputPath: "/tmp/live.output" },
    ],
    { dead: { ts: 0, alive: false } },
  );
  expect((await evaluateEntry(e, 1000, alive)).waiting).toBe(true);
});
