/**
 * Tier-4 push path (portkey ntfy). Covers the whole path short of APNs delivery:
 * the non-sensitive label, the tool→category map, deep-link origin resolution,
 * and the exact ntfy Request (ASCII Title header, emoji via Tags, Unicode in the
 * UTF-8 body). No phone needed.
 *
 * `home` helper first — freezes EVENTS_DIR under a temp HOME (pushAction reads it).
 */

import "../../test/helpers/home";
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import {
  pushLabel,
  pushAction,
  bridgeOrigin,
  portkeyConnected,
  sendPushNotification,
} from "./notifications";
import { PATHS } from "./config";
import { EVENTS_DIR, eventLogPath } from "./hook-events";
import type { HookEvent, NotificationConfig, Session, TransitionEvent } from "../types";

beforeEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
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

const baseConfig: NotificationConfig = {
  statusMonitor: true,
  windowPrefix: true,
  nativeNotification: true,
  ntfyTopic: "mytopic",
  bridgeUrl: "https://host.ts.net",
};

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

// --- portkeyConnected (bridge-consumer marker freshness) ----------------------

const MARKER = `${PATHS.dir}/bridge-consumer`;

test("portkeyConnected: fresh marker → true, stale (>40s) → false, missing → false", () => {
  rmSync(MARKER, { force: true });
  expect(portkeyConnected()).toBe(false); // missing

  writeFileSync(MARKER, "");
  expect(portkeyConnected()).toBe(true); // fresh

  const stale = (Date.now() - 41_000) / 1000;
  utimesSync(MARKER, stale, stale);
  expect(portkeyConnected()).toBe(false); // stale

  rmSync(MARKER, { force: true });
});

// --- bridgeOrigin ------------------------------------------------------------

test("bridgeOrigin returns config.bridgeUrl when set (no detection)", () => {
  expect(bridgeOrigin({ ...baseConfig, bridgeUrl: "https://explicit.ts.net" })).toBe(
    "https://explicit.ts.net",
  );
});

test("bridgeOrigin parses the https origin from `tailscale serve status` line 1", () => {
  const orig = Bun.spawnSync;
  Bun.spawnSync = ((): unknown => ({
    exitCode: 0,
    stdout: Buffer.from("https://host.ts.net (tailnet only)\n/ proxy http://127.0.0.1:8473\n"),
  })) as typeof Bun.spawnSync;
  try {
    expect(bridgeOrigin({ ...baseConfig, bridgeUrl: undefined })).toBe("https://host.ts.net");
  } finally {
    Bun.spawnSync = orig;
  }
});

// --- sendPushNotification (exact Request shape) ------------------------------

test("blocked push: ASCII Title header, Tags: zap, category body, deep-link Click", async () => {
  writePreToolUse("sess-1", "Bash");
  const captured: { url?: string; init?: RequestInit } = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response("ok");
  }) as typeof fetch;
  try {
    const event: TransitionEvent = {
      sessionKey: "%1",
      previousStatus: "running",
      currentStatus: "waiting",
      classification: "blocked",
      session: mkSession(),
    };
    await sendPushNotification(event, event.session, baseConfig);
  } finally {
    globalThis.fetch = origFetch;
  }

  expect(captured.url).toBe("https://ntfy.sh/mytopic");
  const headers = captured.init!.headers as Record<string, string>;
  expect(headers.Title).toBe("Needs your input");
  expect(/^[\x00-\x7F]*$/.test(headers.Title)).toBe(true); // header stays ASCII
  expect(headers.Tags).toBe("zap");
  expect(headers.Priority).toBe("high");
  expect(headers.Click).toBe("https://host.ts.net/?s=sess-1");
  expect(captured.init!.body).toBe("csm · Fix Auth — run a command");
});

test("turnComplete push: Title `Turn complete`, Tags: white_check_mark, label-only body", async () => {
  const captured: { url?: string; init?: RequestInit } = {};
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response("ok");
  }) as typeof fetch;
  try {
    const event: TransitionEvent = {
      sessionKey: "%1",
      previousStatus: "running",
      currentStatus: "ready",
      classification: "turnComplete",
      session: mkSession({ status: "ready" }),
    };
    await sendPushNotification(event, event.session, baseConfig);
  } finally {
    globalThis.fetch = origFetch;
  }

  const headers = captured.init!.headers as Record<string, string>;
  expect(headers.Title).toBe("Turn complete");
  expect(headers.Tags).toBe("white_check_mark");
  expect(captured.init!.body).toBe("csm · Fix Auth");
});

afterEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
});
