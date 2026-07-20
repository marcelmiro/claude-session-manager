import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { readLastTurnAt } from "./last-turn";

let dir: string;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/csm-last-turn-`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a transcript and return its path. Each call gets a fresh name so the
 *  mtime-keyed memo in `readLastTurnAt` can't serve a previous test's result. */
function transcript(lines: object[]): string {
  const path = `${dir}/t${n++}.jsonl`;
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const turn = (type: "user" | "assistant", timestamp: string) => ({
  type,
  timestamp,
  message: { role: type, content: "hi" },
});

test("returns the last conversational turn's timestamp", () => {
  const path = transcript([
    turn("user", "2026-07-18T10:00:00.000Z"),
    turn("assistant", "2026-07-18T10:05:00.000Z"),
  ]);
  expect(readLastTurnAt(path)).resolves.toBe(Date.parse("2026-07-18T10:05:00.000Z"));
});

test("ignores trailing bookkeeping records that bump file mtime", () => {
  // The real-world shape: a session that stopped talking days ago, then had `mode`,
  // `last-prompt` and friends appended — the writes that made mtime lie.
  const path = transcript([
    turn("assistant", "2026-07-18T17:31:02.000Z"),
    { type: "mode", mode: "acceptEdits" },
    { type: "permission-mode" },
    { type: "ai-title", title: "some name" },
    { type: "file-history-snapshot", messageId: "x" },
    { type: "last-prompt", prompt: "..." },
  ]);
  expect(readLastTurnAt(path)).resolves.toBe(Date.parse("2026-07-18T17:31:02.000Z"));
});

test("null when no record carries a timestamp (caller falls back to mtime)", () => {
  const path = transcript([{ type: "mode" }, { type: "last-prompt" }]);
  expect(readLastTurnAt(path)).resolves.toBeNull();
});

test("tolerates a truncated final line", () => {
  const path = transcript([turn("assistant", "2026-07-18T10:05:00.000Z")]);
  writeFileSync(path, `${JSON.stringify(turn("assistant", "2026-07-18T10:05:00.000Z"))}\n{"type":"us`);
  expect(readLastTurnAt(path)).resolves.toBe(Date.parse("2026-07-18T10:05:00.000Z"));
});

test("null for a missing file", async () => {
  expect(await readLastTurnAt(`${dir}/nope.jsonl`)).toBeNull();
});

test("re-reads once the file changes, serves the memo while it doesn't", async () => {
  const path = transcript([turn("assistant", "2026-07-18T10:05:00.000Z")]);
  expect(await readLastTurnAt(path)).toBe(Date.parse("2026-07-18T10:05:00.000Z"));

  // Rewrite with a newer turn AND a new mtime — the memo must invalidate.
  writeFileSync(path, JSON.stringify(turn("assistant", "2026-07-19T09:00:00.000Z")) + "\n");
  expect(await readLastTurnAt(path)).toBe(Date.parse("2026-07-19T09:00:00.000Z"));

  // Same mtime, different bytes: the memo answers, proving it isn't re-parsing.
  const stat = await Bun.file(path).stat();
  writeFileSync(path, JSON.stringify(turn("assistant", "2026-07-20T09:00:00.000Z")) + "\n");
  utimesSync(path, stat!.atimeMs / 1000, stat!.mtimeMs / 1000);
  expect(await readLastTurnAt(path)).toBe(Date.parse("2026-07-19T09:00:00.000Z"));
});
