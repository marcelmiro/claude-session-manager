import { test, expect } from "bun:test";
import { tapTarget } from "./tap-target.js";

const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);
const ago = (ms: number) => NOW - ms;

// The two cases that matter, both captured on-device: a tap empties the shade, a
// manual open leaves the notification in it.
test("tapped notification vanished from the shade → open that session", () => {
  expect(tapTarget({ s1: ago(3_000) }, [], NOW)).toBe("s1");
});

test("notification still in the shade → opened some other way, stay put", () => {
  expect(tapTarget({ s1: ago(3_000) }, ["s1"], NOW)).toBe(null);
});

test("tapping one of several attributes only the vanished one", () => {
  const pushed = { s1: ago(3_000), s2: ago(9_000), s3: ago(1_000) };
  expect(tapTarget(pushed, ["s1", "s3"], NOW)).toBe("s2");
});

test("several vanished at once is unattributable — never guess", () => {
  const pushed = { s1: ago(3_000), s2: ago(9_000) };
  expect(tapTarget(pushed, [], NOW)).toBe(null);
});

test("a push older than the TTL no longer counts as a tap", () => {
  expect(tapTarget({ s1: ago(120_001) }, [], NOW)).toBe(null);
  expect(tapTarget({ s1: ago(119_999) }, [], NOW)).toBe("s1");
});

// An expired push must not mask a live one — otherwise a stale entry silently turns
// a real tap into "several vanished" and the deep link goes dead.
test("expired entries are ignored, not counted toward ambiguity", () => {
  const pushed = { old: ago(300_000), fresh: ago(2_000) };
  expect(tapTarget(pushed, [], NOW)).toBe("fresh");
});

test("no recorded pushes → nothing to attribute", () => {
  expect(tapTarget({}, [], NOW)).toBe(null);
  expect(tapTarget(null as never, [], NOW)).toBe(null);
});

