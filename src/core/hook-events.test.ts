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
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  readEvents,
  eventSourcedStatus,
  pendingToolCall,
  eventLogPath,
  readTranscriptSince,
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

test("pendingToolCall: an open PreToolUse before the last Stop is stale → null", () => {
  // A dropped PostToolUse (e.g. a Bash that spawned a detached process holding the
  // hook's pipe) leaves a PreToolUse open; the turn then ends with Stop. That tool is
  // NOT still running — without this guard the bridge showed a phantom "running — Bash".
  const id = "sess-stale-pre";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_dangling", tool_input: { command: "caffeinate csm bridge" } }, "x"),
    ev({ hook_event_name: "Stop" }, "x"),
  ]);
  expect(pendingToolCall(id)).toBeNull();
});

test("pendingToolCall: a fresh PreToolUse after the last Stop is live → returned", () => {
  // A stale dangling tool from a prior turn must not mask a genuinely in-flight tool
  // opened in the current (post-Stop) turn.
  const id = "sess-fresh-after-stop";
  writeLog(id, [
    ev({ hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "tu_stale", tool_input: { file_path: "/a" } }, "x"),
    ev({ hook_event_name: "Stop" }, "x"),
    ev({ hook_event_name: "UserPromptSubmit" }, "x"),
    ev({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "tu_live", tool_input: { command: "ls" } }, "x"),
  ]);
  const call = pendingToolCall(id);
  expect(call?.name).toBe("Bash");
  expect(call?.toolUseId).toBe("tu_live");
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

// --- readTranscriptSince (append-only delta read for the bridge) ----------------

const txPath = () => join(EVENTS_DIR, "tx.jsonl");
const rec = (role: "user" | "assistant", text: string) =>
  JSON.stringify({ type: role, message: { role, content: text } }) + "\n";

test("readTranscriptSince: since=0 reads the whole log, fromStart=true, cursor at EOF", async () => {
  writeFileSync(txPath(), rec("user", "one") + rec("assistant", "two"));
  const s = await readTranscriptSince(txPath(), 0);
  expect(s.turns.map((t) => t.content[0]!.type === "text" && t.content[0]!.text)).toEqual(["one", "two"]);
  expect(s.fromStart).toBe(true);
  expect(s.cursor).toBe(Buffer.byteLength(rec("user", "one") + rec("assistant", "two")));
});

test("readTranscriptSince: a prior cursor returns ONLY the appended turns (delta)", async () => {
  writeFileSync(txPath(), rec("user", "one"));
  const first = await readTranscriptSince(txPath(), 0);
  appendFileSync(txPath(), rec("assistant", "two"));
  const delta = await readTranscriptSince(txPath(), first.cursor);
  expect(delta.turns.length).toBe(1);
  expect(delta.turns[0]!.content[0]!.type === "text" && delta.turns[0]!.content[0]!.text).toBe("two");
  expect(delta.fromStart).toBe(false);
});

test("readTranscriptSince: a half-written trailing line is not consumed until its newline lands", async () => {
  writeFileSync(txPath(), rec("user", "one"));
  const first = await readTranscriptSince(txPath(), 0);
  // partial append (no newline yet) — must NOT advance the cursor or yield a turn
  appendFileSync(txPath(), '{"type":"assistant","message":{"role":"assistant","content":"par');
  const partial = await readTranscriptSince(txPath(), first.cursor);
  expect(partial.turns).toEqual([]);
  expect(partial.cursor).toBe(first.cursor);
  // complete the line — now it parses exactly once
  appendFileSync(txPath(), 'tial"}}\n');
  const done = await readTranscriptSince(txPath(), partial.cursor);
  expect(done.turns.length).toBe(1);
  expect(done.turns[0]!.content[0]!.type === "text" && done.turns[0]!.content[0]!.text).toBe("partial");
});

test("readTranscriptSince: since past EOF (log reset/compacted) restarts from 0", async () => {
  writeFileSync(txPath(), rec("user", "fresh"));
  const s = await readTranscriptSince(txPath(), 999999);
  expect(s.fromStart).toBe(true);
  expect(s.turns.length).toBe(1);
});

test("readTranscriptSince: missing file → empty, no throw", async () => {
  const s = await readTranscriptSince(join(EVENTS_DIR, "nope.jsonl"), 0);
  expect(s.turns).toEqual([]);
});
