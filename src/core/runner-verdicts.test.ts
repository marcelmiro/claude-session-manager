/**
 * The lsof binary must resolve to a real executable at import time: the probe treats
 * a spawn failure as "runner dead", so a wrong path silently reports every background
 * task as finished (no ⏳ prefix, no portkey pill) rather than erroring.
 */
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { LSOF } from "./runner-verdicts";

test("LSOF resolves to an existing absolute lsof binary", () => {
  expect(LSOF.endsWith("lsof")).toBe(true);
  expect(LSOF.startsWith("/")).toBe(true);
  expect(existsSync(LSOF)).toBe(true);
});
