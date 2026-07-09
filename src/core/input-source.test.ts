/**
 * Input-source attribution (portkey push gating). Pins the truncation-safe
 * anchor logic: text-match on the current turn's UserPromptSubmit, prompt_id-match
 * for approvals/answers, and the fail-to-"tui" direction when the anchor turn has
 * scrolled out of the 200-line log tail.
 *
 * `home` helper first — freezes SOURCE_DIR/EVENTS_DIR under a temp HOME.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { markPortkeySource, sourceForSession, SOURCE_DIR } from "./input-source";
import { EVENTS_DIR, eventLogPath } from "./hook-events";
import type { HookEvent } from "../types";

beforeEach(() => {
  for (const dir of [EVENTS_DIR, SOURCE_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
});

function writeLog(id: string, events: Partial<HookEvent>[]): void {
  const lines = events.map((e) => JSON.stringify({ session_id: id, ...e })).join("\n");
  writeFileSync(eventLogPath(id), lines + "\n");
}

test('"tui" when no marker exists', () => {
  writeLog("s1", [{ hook_event_name: "UserPromptSubmit", prompt: "hi", prompt_id: "p1" }]);
  expect(sourceForSession("s1")).toBe("tui");
});

test('"portkey" when marker text equals the last UserPromptSubmit.prompt', () => {
  writeLog("s2", [{ hook_event_name: "UserPromptSubmit", prompt: "fix the bug", prompt_id: "p1" }]);
  markPortkeySource("s2", "fix the bug");
  expect(sourceForSession("s2")).toBe("portkey");
});

test('"portkey" when marker turnPromptId equals the last UserPromptSubmit.prompt_id (approval-after-TUI-prompt)', () => {
  // TUI typed the prompt; portkey approved a tool mid-turn (no text marker).
  writeLog("s3", [
    { hook_event_name: "UserPromptSubmit", prompt: "typed at desk", prompt_id: "turn-9" },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1" },
  ]);
  markPortkeySource("s3"); // no text ⇒ anchors turn-9
  expect(sourceForSession("s3")).toBe("portkey");
});

test('"tui" when a newer UserPromptSubmit follows the anchor turn', () => {
  // Portkey message, then a desk-typed prompt starts a new turn.
  writeLog("s4", [
    { hook_event_name: "UserPromptSubmit", prompt: "from phone", prompt_id: "p1" },
    { hook_event_name: "UserPromptSubmit", prompt: "typed at desk", prompt_id: "p2" },
  ]);
  markPortkeySource("s4", "from phone");
  expect(sourceForSession("s4")).toBe("tui");
});

test('truncation: anchor UserPromptSubmit trimmed out of the tail ⇒ "tui", never a stuck "portkey"', () => {
  markPortkeySource("s5", "the original message");
  // The 200-line trim scrolled the anchor turn out; only later events remain.
  writeLog("s5", [
    { hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "t1" },
    { hook_event_name: "Stop" },
  ]);
  expect(sourceForSession("s5")).toBe("tui");
});

test("markPortkeySource(id) with no UserPromptSubmit writes an empty marker ⇒ stays \"tui\"", () => {
  writeLog("s6", [{ hook_event_name: "SessionStart" }]);
  markPortkeySource("s6");
  expect(sourceForSession("s6")).toBe("tui");
});
