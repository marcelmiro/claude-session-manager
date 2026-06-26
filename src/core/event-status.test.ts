/**
 * Contract A — event-sourced status truth table.
 *
 * RED ON PURPOSE: this imports `./event-status`, which Impl #2 creates. Until
 * then the import fails and this file alone goes red ("Unhandled error between
 * tests"); the rest of the suite still runs. DO NOT create `event-status.ts`
 * here to make it pass — its absence is the deliverable, and these failing
 * assertions ARE Impl #2's executable spec.
 *
 * This file pins event-status.ts's contract, so the interface is specified here:
 * a pure function
 *
 *   deriveStatus(events: HookEvent[], opts?: { transcript?: TranscriptEntry[] }): SessionStatus
 *
 * where `events` is the ordered hook-event history (each a parsed `hooks/*.json`
 * payload) and the optional `transcript` is the missed-edge backstop (doc 00
 * §Architecture). Status is derived from events, NOT scraped from the viewport —
 * so the scroll-up viewport that fools `detectStatus` is irrelevant here.
 */

import { test, expect } from "bun:test";
import { deriveStatus, toolInFlight, type HookEvent } from "./event-status";
import { fixtureJson } from "../../test/helpers/fixture";

const sessionStart = fixtureJson("hooks/sessionstart.json") as HookEvent;
const userPromptSubmit = fixtureJson("hooks/userpromptsubmit.json") as HookEvent;
const preToolUse = fixtureJson("hooks/pretooluse.json") as HookEvent;
const postToolUse = fixtureJson("hooks/posttooluse.json") as HookEvent;
const notificationPermission = fixtureJson("hooks/notification-permission.json") as HookEvent;
const notificationIdle = fixtureJson("hooks/notification-idle.json") as HookEvent;
const stop = fixtureJson("hooks/stop.json") as HookEvent;

test("SessionStart → idle", () => {
  expect(deriveStatus([sessionStart])).toBe("idle");
});

test("UserPromptSubmit → running", () => {
  expect(deriveStatus([sessionStart, userPromptSubmit])).toBe("running");
});

test("PreToolUse with no following PostToolUse → running", () => {
  expect(deriveStatus([sessionStart, userPromptSubmit, preToolUse])).toBe("running");
});

test("Notification permission_prompt → waiting", () => {
  expect(
    deriveStatus([sessionStart, userPromptSubmit, preToolUse, notificationPermission]),
  ).toBe("waiting");
});

test("Notification idle_prompt → ready", () => {
  // idle_prompt fires ~60s after a turn completes — the session is just sitting
  // at an empty prompt, not blocked. Mapping it to `ready` (not `waiting`) keeps
  // the post-Stop ready→idle_prompt sequence a no-op transition, so it can't
  // raise a spurious "blocked" attention ping. Genuine attention cases
  // (permission_prompt, pending AskUserQuestion/tool from the PreToolUse hook)
  // are covered on their own paths.
  expect(deriveStatus([sessionStart, notificationIdle])).toBe("ready");
});

test("Stop → ready", () => {
  expect(
    deriveStatus([sessionStart, userPromptSubmit, preToolUse, postToolUse, stop]),
  ).toBe("ready");
});

const e = (name: HookEvent["hook_event_name"], tool_use_id?: string): HookEvent =>
  ({ session_id: "s", hook_event_name: name, transcript_path: "x", cwd: "/", tool_use_id } as HookEvent);

test("pending AskUserQuestion → waiting (not running)", () => {
  const ask = { ...preToolUse, tool_name: "AskUserQuestion" } as HookEvent;
  expect(deriveStatus([sessionStart, userPromptSubmit, ask])).toBe("waiting");
});

test("a non-AskUserQuestion PreToolUse is still running", () => {
  expect(deriveStatus([sessionStart, userPromptSubmit, preToolUse])).toBe("running");
});

test("toolInFlight: open PreToolUse with no Stop after it → true", () => {
  expect(toolInFlight([e("UserPromptSubmit"), e("PreToolUse", "tu_1")])).toBe(true);
});

test("toolInFlight: a closed PreToolUse is not in flight → false", () => {
  expect(toolInFlight([e("PreToolUse", "tu_1"), e("PostToolUse", "tu_1")])).toBe(false);
});

test("toolInFlight: parallel tools — one still open → true", () => {
  expect(
    toolInFlight([e("PreToolUse", "tu_a"), e("PreToolUse", "tu_b"), e("PostToolUse", "tu_a")]),
  ).toBe(true);
});

test("toolInFlight: a Stop after the open PreToolUse marks it stale → false", () => {
  expect(toolInFlight([e("PreToolUse", "tu_old"), e("Stop"), e("PreToolUse", "tu_new"), e("PostToolUse", "tu_new")])).toBe(false);
});

test("headline regression: running event history → running (viewport scroll irrelevant)", () => {
  // The scroll-up viewport that makes detectStatus return `ready` cannot reach
  // this function — status comes from the event stream, where the open
  // PreToolUse (no PostToolUse, no Stop) is unambiguously `running`.
  expect(deriveStatus([sessionStart, userPromptSubmit, preToolUse])).toBe("running");
});
