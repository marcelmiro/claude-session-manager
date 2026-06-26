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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function ev(partial: Partial<HookEvent> & { hook_event_name: HookEvent["hook_event_name"] }, transcript: string): HookEvent {
  return { session_id: "s", cwd: "/tmp", transcript_path: transcript, ...partial } as HookEvent;
}

// --- eventSourcedStatus (pure edges: status = newest determining edge) ---------

test("open PreToolUse → running", async () => {
  const id = "sess-running";
  writeLog(id, [
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_1" }, "x"),
  ]);
  expect(await eventSourcedStatus(id)).toBe("running");
});

test("a stale dangling tool from a prior turn does NOT demote a fresh running turn", async () => {
  // A dropped PostToolUse leaves an open PreToolUse; a new turn then starts
  // (UserPromptSubmit). The old pairing/timeout backstop read this as `ready` and
  // re-fired a spurious turnComplete every cycle (the cos-l2 ⚡ bug). Pure edges
  // keep it `running` — status is whatever the newest edge says.
  const id = "sess-stale-dangling";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_old" }, "x"), // never closed
    ev({ hook_event_name: "Stop" }, "x"),
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
  ]);
  expect(await eventSourcedStatus(id)).toBe("running");
});

test("Stop edge → ready; no event log → null", async () => {
  const id = "sess-stop";
  writeLog(id, [ev({ hook_event_name: "Stop" }, "x")]);
  expect(await eventSourcedStatus(id)).toBe("ready");
  expect(await eventSourcedStatus("nonexistent-session")).toBeNull();
});

test("pending AskUserQuestion → waiting", async () => {
  const id = "sess-ask-waiting";
  writeLog(id, [
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "tu_q" }, "x"),
  ]);
  expect(await eventSourcedStatus(id)).toBe("waiting");
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
