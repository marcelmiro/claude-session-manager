/**
 * Approval IPC round-trip (Inc6/Inc7). Pins the fs contract that the blocking
 * `pretooluse.sh` relies on: decision-file writes, pending enrichment from the
 * logged PreToolUse event, and dead-session reaping.
 *
 * `home` helper first — freezes PENDING_DIR/DECISIONS_DIR/EVENTS_DIR under temp HOME.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  decideApproval,
  listPendingApprovals,
  reapDeadSessionFiles,
  PENDING_DIR,
  DECISIONS_DIR,
} from "./approval";
import { EVENTS_DIR, eventLogPath } from "./hook-events";
import type { HookEvent } from "../types";

beforeEach(() => {
  for (const dir of [EVENTS_DIR, PENDING_DIR, DECISIONS_DIR]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
});

test("decideApproval(allow) writes a decision file with no reason", () => {
  decideApproval("sess-a", "allow");
  const payload = JSON.parse(readFileSync(`${DECISIONS_DIR}/sess-a.json`, "utf8"));
  expect(payload.sessionId).toBe("sess-a");
  expect(payload.decision).toBe("allow");
  expect(payload.reason).toBeUndefined();
  expect(typeof payload.ts).toBe("number");
});

test("decideApproval(deny, reason) records the reason", () => {
  decideApproval("sess-b", "deny", "not allowed here");
  const payload = JSON.parse(readFileSync(`${DECISIONS_DIR}/sess-b.json`, "utf8"));
  expect(payload.decision).toBe("deny");
  expect(payload.reason).toBe("not allowed here");
});

test("listPendingApprovals enriches `input` from the logged PreToolUse event", () => {
  const id = "sess-pending";
  // The shell writes a MINIMAL record — no `input`.
  writeFileSync(
    `${PENDING_DIR}/${id}.json`,
    JSON.stringify({ sessionId: id, ts: 123, tool: "Bash", tool_use_id: "tu_9" }),
  );
  // The full tool_input lives only in the event log.
  const pre: HookEvent = {
    session_id: id,
    hook_event_name: "PreToolUse",
    transcript_path: "x",
    cwd: "/tmp",
    tool_name: "Bash",
    tool_use_id: "tu_9",
    tool_input: { command: "rm -rf /tmp/x" },
  };
  writeFileSync(eventLogPath(id), JSON.stringify(pre) + "\n");

  const pending = listPendingApprovals();
  expect(pending).toHaveLength(1);
  expect(pending[0].sessionId).toBe(id);
  expect(pending[0].tool).toBe("Bash");
  expect(pending[0].tool_use_id).toBe("tu_9");
  expect(pending[0].input).toEqual({ command: "rm -rf /tmp/x" });
});

test("listPendingApprovals returns [] when the dir is absent", () => {
  rmSync(PENDING_DIR, { recursive: true, force: true });
  expect(listPendingApprovals()).toEqual([]);
});

test("reapDeadSessionFiles removes dead ids across all dirs, keeps live", () => {
  writeFileSync(eventLogPath("live"), "{}\n");
  writeFileSync(eventLogPath("dead"), "{}\n");
  writeFileSync(`${PENDING_DIR}/live.json`, "{}");
  writeFileSync(`${PENDING_DIR}/dead.json`, "{}");
  writeFileSync(`${DECISIONS_DIR}/live.json`, "{}");
  writeFileSync(`${DECISIONS_DIR}/dead.json`, "{}");

  reapDeadSessionFiles(new Set(["live"]));

  expect(existsSync(eventLogPath("live"))).toBe(true);
  expect(existsSync(`${PENDING_DIR}/live.json`)).toBe(true);
  expect(existsSync(`${DECISIONS_DIR}/live.json`)).toBe(true);
  expect(existsSync(eventLogPath("dead"))).toBe(false);
  expect(existsSync(`${PENDING_DIR}/dead.json`)).toBe(false);
  expect(existsSync(`${DECISIONS_DIR}/dead.json`)).toBe(false);
});
