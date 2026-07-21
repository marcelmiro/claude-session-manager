import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { readLastTurnAt, readLastPromptAt, isPromptRecord } from "./last-turn";

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

// --- isPromptRecord / readLastPromptAt ---------------------------------------

const prompt = (text: string, timestamp: string) => ({
  type: "user",
  timestamp,
  message: { role: "user", content: text },
});

test("isPromptRecord: typed prompts yes; plumbing user records no", () => {
  expect(isPromptRecord(prompt("fix the bug", "t"))).toBe(true);
  expect(
    isPromptRecord({ type: "user", message: { content: [{ type: "image", source: {} }] } }),
  ).toBe(true);
  // Harness records logged with role user:
  expect(isPromptRecord(prompt("<task-notification>\n<task-id>b1</task-id>", "t"))).toBe(false);
  expect(isPromptRecord(prompt("<command-message>/foo</command-message>", "t"))).toBe(false);
  expect(isPromptRecord(prompt("[Request interrupted by user]", "t"))).toBe(false);
  expect(
    isPromptRecord({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x" }] } }),
  ).toBe(false);
  expect(isPromptRecord({ ...prompt("hi", "t"), isMeta: true })).toBe(false);
  expect(isPromptRecord({ ...prompt("hi", "t"), isSidechain: true })).toBe(false);
  expect(isPromptRecord(turn("assistant", "t"))).toBe(false);
});

test("readLastPromptAt: newest REAL prompt, skipping tool_results and notifications behind it", () => {
  const path = transcript([
    prompt("first ask", "2026-07-18T10:00:00.000Z"),
    turn("assistant", "2026-07-18T10:01:00.000Z"),
    prompt("second ask", "2026-07-18T11:00:00.000Z"),
    { type: "user", timestamp: "2026-07-18T11:02:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] } },
    prompt("<task-notification>\n<task-id>b1</task-id>", "2026-07-18T11:30:00.000Z"),
    turn("assistant", "2026-07-18T11:31:00.000Z"),
  ]);
  expect(readLastPromptAt(path)).resolves.toBe(Date.parse("2026-07-18T11:00:00.000Z"));
});

// A message consumed from the input queue mid-turn — never a `user` record, only this.
const queuedPrompt = (text: string, timestamp: string, commandMode = "prompt") => ({
  type: "attachment",
  timestamp,
  attachment: { type: "queued_command", prompt: text, commandMode },
});

test("isPromptRecord: queued-prompt attachments count; task-notification mode doesn't", () => {
  expect(isPromptRecord(queuedPrompt("also fix the tests", "t"))).toBe(true);
  expect(isPromptRecord(queuedPrompt("<task-notification>\n<task-id>b1</task-id>", "t", "task-notification"))).toBe(false);
  // Same NON_PROMPT gate as typed prompts — a queued slash-command echo is plumbing.
  expect(isPromptRecord(queuedPrompt("<command-message>/foo</command-message>", "t"))).toBe(false);
});

test("readLastPromptAt: a queued prompt consumed mid-turn moves the boundary", () => {
  const path = transcript([
    prompt("first ask", "2026-07-18T10:00:00.000Z"),
    turn("assistant", "2026-07-18T10:01:00.000Z"),
    queuedPrompt("also fix the tests", "2026-07-18T10:30:00.000Z"),
    turn("assistant", "2026-07-18T10:31:00.000Z"),
  ]);
  expect(readLastPromptAt(path)).resolves.toBe(Date.parse("2026-07-18T10:30:00.000Z"));
});

test("readLastPromptAt: null when the transcript holds no typed prompt", () => {
  const path = transcript([turn("assistant", "2026-07-18T10:05:00.000Z"), { type: "mode" }]);
  expect(readLastPromptAt(path)).resolves.toBeNull();
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
