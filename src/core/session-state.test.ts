/**
 * I/O coverage for the native session-status reader. `loadNativeStatuses(dir)` is
 * pure on its `dir` arg (it deliberately bypasses the CSM_HOME seam — it reads
 * Claude's dir, not CSM's), so fixtures are `<pid>.json` files written to a fresh
 * temp dir. `process.pid` stands in for a guaranteed-live pid; `999999` for a dead
 * one.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNativeStatuses, nativeSessionIdByPid } from "./session-state";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-native-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, obj: Record<string, unknown>): void {
  writeFileSync(join(dir, name), JSON.stringify(obj));
}

const base = {
  sessionId: "S",
  cwd: "/x",
  kind: "interactive",
  pid: process.pid,
  updatedAt: 1,
};

test("busy/idle/waiting map to running/ready/waiting", async () => {
  writeFile("1.json", { ...base, sessionId: "busy", status: "busy" });
  writeFile("2.json", { ...base, sessionId: "idle", status: "idle" });
  writeFile("3.json", { ...base, sessionId: "wait", status: "waiting" });
  const map = await loadNativeStatuses(dir);
  expect(map.get("busy")).toBe("running");
  expect(map.get("idle")).toBe("ready");
  expect(map.get("wait")).toBe("waiting");
});

test("dead pid excluded, live pid included", async () => {
  writeFile("dead.json", { ...base, sessionId: "dead", pid: 999999, status: "busy" });
  writeFile("live.json", { ...base, sessionId: "live", pid: process.pid, status: "busy" });
  const map = await loadNativeStatuses(dir);
  expect(map.has("dead")).toBe(false);
  expect(map.get("live")).toBe("running");
});

test("duplicate sessionId: larger updatedAt wins", async () => {
  writeFile("old.json", { ...base, sessionId: "dup", status: "busy", updatedAt: 100 });
  writeFile("new.json", { ...base, sessionId: "dup", status: "idle", updatedAt: 200 });
  const map = await loadNativeStatuses(dir);
  expect(map.get("dup")).toBe("ready"); // idle (updatedAt 200) beats busy (100)
});

test("non-interactive kind and unknown status are excluded", async () => {
  writeFile("headless.json", { ...base, sessionId: "headless", kind: "print", status: "busy" });
  writeFile("unknown.json", { ...base, sessionId: "unknown", status: "frobnicating" });
  const map = await loadNativeStatuses(dir);
  expect(map.has("headless")).toBe(false);
  expect(map.has("unknown")).toBe(false);
});

test("malformed JSON does not throw and does not poison other entries", async () => {
  writeFileSync(join(dir, "junk.json"), "{ not valid json");
  writeFile("good.json", { ...base, sessionId: "good", status: "idle" });
  const map = await loadNativeStatuses(dir);
  expect(map.get("good")).toBe("ready");
  expect(map.size).toBe(1);
});

test("missing dir returns empty map without throwing", async () => {
  const map = await loadNativeStatuses(join(dir, "does-not-exist"));
  expect(map.size).toBe(0);
});

// --- nativeSessionIdByPid — the fork's REAL id, keyed by pid ---------------------
// A --fork-session pane's SessionStart hook records the PARENT id; the fork's own
// id lives only in Claude's per-pid native file. This is how CSM recovers it.

test("nativeSessionIdByPid returns the id from the pid's native file", async () => {
  writeFile("12461.json", { ...base, pid: 12461, sessionId: "fork-real-id", status: "idle" });
  expect(await nativeSessionIdByPid(12461, dir)).toBe("fork-real-id");
});

test("nativeSessionIdByPid: missing file → null (fork's native file not written yet)", async () => {
  expect(await nativeSessionIdByPid(99999, dir)).toBeNull();
});

test("nativeSessionIdByPid: non-interactive kind → null", async () => {
  writeFile("500.json", { ...base, pid: 500, sessionId: "headless", kind: "print", status: "busy" });
  expect(await nativeSessionIdByPid(500, dir)).toBeNull();
});

test("nativeSessionIdByPid: malformed file → null without throwing", async () => {
  writeFileSync(join(dir, "501.json"), "{ not json");
  expect(await nativeSessionIdByPid(501, dir)).toBeNull();
});
