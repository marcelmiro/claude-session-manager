/**
 * I/O coverage for the Inc3/Inc4 event-log reader. The pure edge truth-table is
 * pinned in `event-status.test.ts`; this file pins the fs-touching paths that were
 * only ever checked by hand: the missed-edge backstop (transcript pairing + mtime
 * quiet), append-order/corruption tolerance in `readEvents`, and the
 * pending-tool-call sourcing/closing logic.
 *
 * `./../../test/helpers/home` MUST stay the first import — it redirects $HOME to a
 * temp dir before `hook-events` → `config` freezes `EVENTS_DIR`.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import {
  readEvents,
  eventSourcedStatus,
  pendingToolCall,
  eventLogPath,
  EVENTS_DIR,
} from "./hook-events";
import { fixtureJson } from "../../test/helpers/fixture";
import type { HookEvent } from "../types";

beforeEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
});

/** Write `events` to a session log, one JSON object per line (append order). */
function writeLog(sessionId: string, events: HookEvent[]): void {
  writeFileSync(eventLogPath(sessionId), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** Write a minimal JSONL transcript and (optionally) age its mtime. */
function writeTranscript(path: string, turns: object[], ageMs = 0): void {
  writeFileSync(path, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
  }
}

function ev(partial: Partial<HookEvent> & { hook_event_name: HookEvent["hook_event_name"] }, transcript: string): HookEvent {
  return { session_id: "s", cwd: "/tmp", transcript_path: transcript, ...partial } as HookEvent;
}

// --- eventSourcedStatus: missed-edge backstop (Inc4) ---------------------------

test("open PreToolUse + fresh transcript with no tool_result → running", async () => {
  const id = "sess-running";
  const tp = `${EVENTS_DIR}/${id}.transcript.jsonl`;
  writeTranscript(tp, [{ type: "assistant", message: { content: "working on it" } }]);
  writeLog(id, [
    ev({ hook_event_name: "UserPromptSubmit" }, tp),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, tp),
  ]);
  expect(await eventSourcedStatus(id)).toBe("running");
});

test("in-flight tool: open PreToolUse + tool_result but FRESH transcript → running (no false turnComplete)", async () => {
  // The bug: between back-to-back tools the transcript holds a tool_result a few ms
  // before its PostToolUse edge is logged. A fresh transcript means the tool is
  // in-flight (PostToolUse imminent) — demoting here flips an actively-working
  // session ready↔running and fires spurious turnComplete pings. Must stay running.
  const id = "sess-inflight";
  const tp = `${EVENTS_DIR}/${id}.transcript.jsonl`;
  writeTranscript(tp, [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } },
  ]); // ageMs=0 → mtime is now (fresh)
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, tp),
  ]);
  expect(await eventSourcedStatus(id)).toBe("running");
});

test("dropped PostToolUse: open PreToolUse + tool_result on a SETTLED transcript → ready (pairing demotion)", async () => {
  const id = "sess-paired";
  const tp = `${EVENTS_DIR}/${id}.transcript.jsonl`;
  // Same as in-flight, but the transcript has been quiet past the settle window →
  // the terminal edge was genuinely dropped, so demotion is correct here.
  writeTranscript(tp, [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] } },
  ], 30_000);
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, tp),
  ]);
  expect(await eventSourcedStatus(id)).toBe("ready");
});

test("open PreToolUse + stale transcript (> QUIET_MS) → ready (mtime demotion)", async () => {
  const id = "sess-stale";
  const tp = `${EVENTS_DIR}/${id}.transcript.jsonl`;
  // No tool_result so pairing can't demote — only the aged mtime can.
  writeTranscript(tp, [{ type: "assistant", message: { content: "waiting" } }], 200_000);
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, tp),
  ]);
  expect(await eventSourcedStatus(id)).toBe("ready");
});

test("Stop edge → ready; no event log → null", async () => {
  const id = "sess-stop";
  const tp = `${EVENTS_DIR}/${id}.transcript.jsonl`;
  writeLog(id, [ev({ hook_event_name: "Stop" }, tp)]);
  expect(await eventSourcedStatus(id)).toBe("ready");
  expect(await eventSourcedStatus("nonexistent-session")).toBeNull();
});

// --- readEvents ----------------------------------------------------------------

test("readEvents preserves append order", () => {
  const id = "sess-order";
  writeLog(id, [
    ev({ hook_event_name: "SessionStart" }, "x"),
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "Stop" }, "x"),
  ]);
  expect(readEvents(id).map((e) => e.hook_event_name)).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
  ]);
});

test("readEvents skips a corrupt/half-written line, keeps the rest", () => {
  const id = "sess-corrupt";
  writeFileSync(
    eventLogPath(id),
    [
      JSON.stringify(ev({ hook_event_name: "SessionStart" }, "x")),
      '{"hook_event_name":"PreToolUse", "tool_n', // torn mid-write
      JSON.stringify(ev({ hook_event_name: "Stop" }, "x")),
    ].join("\n") + "\n",
  );
  expect(readEvents(id).map((e) => e.hook_event_name)).toEqual(["SessionStart", "Stop"]);
});

test("readEvents returns [] when no log exists", () => {
  expect(readEvents("never-existed")).toEqual([]);
});

// --- pendingToolCall -----------------------------------------------------------

test("pendingToolCall sources the last OPEN PreToolUse (A3)", () => {
  const id = "sess-pending";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tu_old", tool_input: { file_path: "/a" } }, "x"),
    ev({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "tu_old" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_new", tool_input: { command: "ls", description: "list" } }, "x"),
  ]);
  const call = pendingToolCall(id);
  expect(call).not.toBeNull();
  expect(call!.name).toBe("Bash");
  expect(call!.toolUseId).toBe("tu_new");
  expect(call!.command).toBe("ls");
  expect(call!.description).toBe("list");
});

test("pendingToolCall returns null when the PreToolUse is closed by PostToolUse", () => {
  const id = "sess-closed";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1", tool_input: { command: "ls" } }, "x"),
    ev({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, "x"),
  ]);
  expect(pendingToolCall(id)).toBeNull();
});

test("pendingToolCall maps AskUserQuestion questions[0] → structured options", () => {
  const id = "sess-ask";
  const ask = fixtureJson("hooks/pretooluse-askuserquestion.json") as HookEvent;
  writeLog(id, [ask]);
  const call = pendingToolCall(id);
  expect(call?.name).toBe("AskUserQuestion");
  expect(call?.question).toBeDefined();
  expect(call!.question!.question).toBe("Pick a fruit");
  expect(call!.question!.header).toBe("Fruit");
  expect(call!.question!.multiSelect).toBe(false);
  expect(call!.question!.options.map((o) => o.label)).toEqual(["Apple", "Banana", "Cherry"]);
  expect(call!.question!.toolUseId).toBe("toolu_017qQwTYpzg8d65MoEjqtPj8");
});
