/**
 * Tier-4 push path (portkey Web Push). Covers the non-sensitive label, the
 * tool→category map, per-device SSE liveness, and the exact push payload the
 * service worker renders. Delivery itself (encryption + POST) is pinned in
 * web-push.test.ts. No phone needed.
 *
 * `home` helper first — freezes EVENTS_DIR under a temp HOME (pushAction reads it).
 */

import "../../test/helpers/home";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { pushLabel, pushAction, deviceConnected, pushPayloadFor } from "./notifications";
import { CONSUMERS_DIR } from "./web-push";
import { EVENTS_DIR, eventLogPath } from "./hook-events";
import type { HookEvent, Session, TransitionEvent } from "../types";

beforeEach(() => {
  for (const dir of [EVENTS_DIR, CONSUMERS_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
});

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    repo: "csm",
    repoPath: "/x",
    baseRepoPath: "/x",
    branch: "",
    status: "waiting",
    contextPercent: 0,
    messageCount: 0,
    summary: "",
    modified: new Date(0),
    firstPrompt: "",
    lastPrompt: "",
    name: "csm/fix-auth",
    ...over,
  };
}

function writePreToolUse(id: string, tool: string): void {
  const e: Partial<HookEvent> = {
    session_id: id,
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_use_id: "t1",
  };
  writeFileSync(eventLogPath(id), JSON.stringify(e) + "\n");
}

// --- pushLabel ---------------------------------------------------------------

test('pushLabel humanizes the ai-name → "csm · Fix Auth"', () => {
  expect(pushLabel(mkSession({ name: "csm/fix-auth" }))).toBe("csm · Fix Auth");
});

test("pushLabel falls back to repo alone when the window name has no ai-name", () => {
  expect(pushLabel(mkSession({ name: "csm", repo: "csm" }))).toBe("csm");
});

// --- pushAction (tool → category) -------------------------------------------

test("pushAction maps the pending tool NAME to a non-sensitive category", () => {
  writePreToolUse("bash-s", "Bash");
  expect(pushAction("bash-s")).toBe("run a command");
  writePreToolUse("edit-s", "Edit");
  expect(pushAction("edit-s")).toBe("make an edit");
  writePreToolUse("write-s", "Write");
  expect(pushAction("write-s")).toBe("make an edit");
  writePreToolUse("ask-s", "AskUserQuestion");
  expect(pushAction("ask-s")).toBe("answer a question");
  writePreToolUse("read-s", "Read");
  expect(pushAction("read-s")).toBe("needs permission");
  expect(pushAction("no-log")).toBe("needs permission"); // no pending tool
});

// --- deviceConnected (per-device consumer marker freshness) -------------------

test("deviceConnected: fresh marker → true, stale (>40s) → false, missing → false", () => {
  const marker = `${CONSUMERS_DIR}/dev-a`;
  expect(deviceConnected("dev-a")).toBe(false); // missing

  writeFileSync(marker, "");
  expect(deviceConnected("dev-a")).toBe(true); // fresh
  expect(deviceConnected("dev-b")).toBe(false); // other devices unaffected

  const stale = (Date.now() - 41_000) / 1000;
  utimesSync(marker, stale, stale);
  expect(deviceConnected("dev-a")).toBe(false); // stale
});

// --- pushPayloadFor (exact payload the service worker renders) ----------------

test("blocked payload: label + category body, sessionId deep link, no capture text", () => {
  writePreToolUse("sess-1", "Bash");
  const event: TransitionEvent = {
    sessionKey: "%1",
    previousStatus: "running",
    currentStatus: "waiting",
    classification: "blocked",
    session: mkSession({ lastCapture: "SECRET pane contents" }),
  };
  const p = pushPayloadFor(event, event.session);
  expect(p.title).toBe("⚡ csm · Fix Auth");
  expect(p.body).toBe("needs your input — run a command");
  expect(p.sessionId).toBe("sess-1");
  expect(JSON.stringify(p)).not.toContain("SECRET"); // never leaks pane capture
});

test("turnComplete payload: label title, state body", () => {
  const event: TransitionEvent = {
    sessionKey: "%1",
    previousStatus: "running",
    currentStatus: "ready",
    classification: "turnComplete",
    session: mkSession({ status: "ready" }),
  };
  const p = pushPayloadFor(event, event.session);
  expect(p.title).toBe("✅ csm · Fix Auth");
  expect(p.body).toBe("turn complete");
  expect(p.sessionId).toBe("sess-1");
});

afterEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
});
