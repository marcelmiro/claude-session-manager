/**
 * Recent-push ledger: what the phone reads to attribute a notification tap.
 *
 * This exists because the service worker cannot hand the record to the page — iOS gives a
 * warm-resumed page a stale CacheStorage snapshot, so a record written by the worker reads
 * back empty seconds later. The sender keeps the ledger instead.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { recordSentPush, takeRecentPushes, PUSHED_DIR } from "./web-push";
import { tapTarget } from "../shared/tap-target.js";

const DEV = "1046efb5-b99a-476d-a0ea-ed2e962377ca";
const NOW = Date.UTC(2026, 6, 27, 21, 0, 0);

beforeEach(() => {
  rmSync(PUSHED_DIR, { recursive: true, force: true });
});

test("records a push and hands it back once", () => {
  recordSentPush(DEV, "s1", NOW);
  expect(takeRecentPushes(DEV, NOW)).toEqual({ s1: NOW });
});

// Delete-on-read: otherwise one push attributes a session on every foreground, and opening
// the app an hour later would jump you into a session you already dealt with.
test("a push is consumed exactly once", () => {
  recordSentPush(DEV, "s1", NOW);
  takeRecentPushes(DEV, NOW);
  expect(takeRecentPushes(DEV, NOW)).toEqual({});
});

test("several pushes accumulate until read", () => {
  recordSentPush(DEV, "s1", NOW - 5_000);
  recordSentPush(DEV, "s2", NOW - 1_000);
  expect(takeRecentPushes(DEV, NOW)).toEqual({ s1: NOW - 5_000, s2: NOW - 1_000 });
});

test("re-pushing a session keeps one entry, freshly stamped", () => {
  recordSentPush(DEV, "s1", NOW - 60_000);
  recordSentPush(DEV, "s1", NOW);
  expect(takeRecentPushes(DEV, NOW)).toEqual({ s1: NOW });
});

test("entries past the TTL are never handed back", () => {
  recordSentPush(DEV, "s1", NOW - 120_001);
  expect(takeRecentPushes(DEV, NOW)).toEqual({});
});

test("writing prunes what aged out, so the file can't grow forever", () => {
  recordSentPush(DEV, "old", NOW - 300_000);
  recordSentPush(DEV, "new", NOW);
  expect(takeRecentPushes(DEV, NOW)).toEqual({ new: NOW });
});

test("ledgers are per-device — one phone's tap can't move another's", () => {
  const other = "97831d61-0985-4af7-8133-ebf107128bbf";
  recordSentPush(DEV, "s1", NOW);
  expect(takeRecentPushes(other, NOW)).toEqual({});
  expect(takeRecentPushes(DEV, NOW)).toEqual({ s1: NOW });
});

test("a bogus deviceId is refused rather than reaching the filesystem", () => {
  recordSentPush("../../etc/passwd", "s1", NOW);
  expect(takeRecentPushes("../../etc/passwd", NOW)).toEqual({});
});

test("no ledger at all reads as empty, not as an error", () => {
  expect(takeRecentPushes(DEV, NOW)).toEqual({});
});

// The end-to-end rule the phone applies: ledger + shade → session to open.
test("ledger feeds the tap attribution the page actually runs", () => {
  recordSentPush(DEV, "tapped", NOW - 3_000);
  recordSentPush(DEV, "ignored", NOW - 2_000);
  const pushes = takeRecentPushes(DEV, NOW);

  // "ignored" is still in the shade; "tapped" left it when the user tapped it.
  expect(tapTarget(pushes, ["ignored"], NOW)).toBe("tapped");
  // Nothing tapped — both still shown — so nothing moves.
  expect(tapTarget(pushes, ["ignored", "tapped"], NOW)).toBe(null);
});
