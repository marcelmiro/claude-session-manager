/**
 * Coverage for the Impl 2.5 handoff surface (`session-api.ts`).
 *
 * Hermetic, repo style: pure fns asserted directly + temp-HOME real-fs (no
 * `mock.module`). `../../test/helpers/home` MUST stay the first import — it redirects
 * CSM_HOME before `config`/`hook-events` freeze `PATHS.dir`/`EVENTS_DIR`.
 *
 * Scope note: the transcript ASSEMBLY is tested via the pure `buildSessionTranscript`
 * (the I/O path resolution uses `homedir()`, which tests can't redirect — matching how
 * `sessions.ts`'s homedir glob is left untested). The senders are thin effectful
 * wrappers over tmux; per repo convention (cf. `tmux.test.ts` covering only the pure
 * `questionAnswerKeys`, not `answerQuestion`) their gate logic is covered by the pure
 * predicate/resolver tests plus the hermetic no-pane short-circuit. The status/question
 * happy paths past a live pane are the plan's manual live checks.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  pickPane,
  canSendFreeText,
  hasOpenQuestion,
  buildSessionTranscript,
  getTranscript,
  sendMessage,
  answerSessionQuestion,
} from "./session-api";
import { parseTranscript } from "./transcript";
import { EVENTS_DIR } from "./hook-events";
import { PATHS } from "./config";
import { fixture } from "../../test/helpers/fixture";
import type { SessionStatus } from "./status";
import type { PendingToolCall } from "./jsonl-reader";

const PANE_SESSIONS = join(PATHS.dir, "pane-sessions.json");

beforeEach(() => {
  rmSync(EVENTS_DIR, { recursive: true, force: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
  mkdirSync(PATHS.dir, { recursive: true });
  rmSync(PANE_SESSIONS, { force: true });
});

// --- pickPane (the resolver) ---------------------------------------------------

test("pickPane: returns the live pane mapped to the session", () => {
  expect(pickPane("s1", { "%1": "s1", "%2": "s2" }, new Set(["%1", "%2"]))).toBe("%1");
});

test("pickPane: session absent from the map → null", () => {
  expect(pickPane("nope", { "%1": "s1" }, new Set(["%1"]))).toBeNull();
});

test("pickPane: mapped pane is stale/not-live → null", () => {
  expect(pickPane("s1", { "%9": "s1" }, new Set(["%1"]))).toBeNull();
});

test("pickPane: picks the right session's pane among several", () => {
  const map = { "%1": "s1", "%2": "s2", "%3": "s3" };
  expect(pickPane("s2", map, new Set(["%1", "%2", "%3"]))).toBe("%2");
});

test("pickPane: two live panes for one session → last-written wins", () => {
  expect(pickPane("s1", { "%1": "s1", "%2": "s1" }, new Set(["%1", "%2"]))).toBe("%2");
});

// --- pure predicates -----------------------------------------------------------

test("canSendFreeText: ready→true; waiting/running/idle/null→false", () => {
  expect(canSendFreeText("ready")).toBe(true);
  for (const s of ["waiting", "running", "idle"] as SessionStatus[]) {
    expect(canSendFreeText(s)).toBe(false);
  }
  expect(canSendFreeText(null)).toBe(false);
});

test("hasOpenQuestion: AskUserQuestion+question→true; Bash/null→false", () => {
  const ask: PendingToolCall = {
    name: "AskUserQuestion",
    toolUseId: "t",
    question: { question: "q", header: "h", options: [{ label: "a" }], multiSelect: false, toolUseId: "t" },
  };
  expect(hasOpenQuestion(ask)).toBe(true);
  expect(hasOpenQuestion({ name: "Bash", toolUseId: "t", command: "ls" })).toBe(false);
  expect(hasOpenQuestion(null)).toBe(false);
});

// --- buildSessionTranscript (the assembly logic) -------------------------------

test("buildSessionTranscript: ordered turns + last assistant, no pending", () => {
  const turns = parseTranscript(fixture("transcripts/approved-tool.jsonl"));
  const t = buildSessionTranscript(turns, null);
  expect(t.turns.map((x) => x.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
  expect(t.lastAssistant).toBe("Done. Created `/tmp/spike-perm-test.txt`.");
  expect(t.pendingTool).toBeUndefined();
  expect(t.openQuestion).toBeUndefined();
});

test("buildSessionTranscript: AskUserQuestion pending → openQuestion derived from it (A3)", () => {
  const turns = parseTranscript(fixture("transcripts/askuserquestion.jsonl"));
  const ask: PendingToolCall = {
    name: "AskUserQuestion",
    toolUseId: "t",
    question: { question: "q", header: "h", options: [{ label: "Apple" }, { label: "Banana" }], multiSelect: false, toolUseId: "t" },
  };
  const t = buildSessionTranscript(turns, ask);
  expect(t.pendingTool).toBe(ask);
  expect(t.openQuestion?.options.map((o) => o.label)).toEqual(["Apple", "Banana"]);
});

test("buildSessionTranscript: non-question pending → pendingTool set, no openQuestion", () => {
  const pending: PendingToolCall = { name: "Bash", toolUseId: "t", command: "ls" };
  const t = buildSessionTranscript([], pending);
  expect(t.pendingTool).toBe(pending);
  expect(t.openQuestion).toBeUndefined();
});

test("getTranscript: unknown session → empty turns, no throw", async () => {
  const t = await getTranscript("never-existed-uuid-xyz");
  expect(t.turns).toEqual([]);
  expect(t.lastAssistant).toBeUndefined();
});

// --- send/answer no-pane short-circuit (hermetic: never reaches tmux) ----------

test("sendMessage: no pane mapping → no-pane, sends nothing", async () => {
  const r = await sendMessage("ghost-session", "hi");
  expect(r).toEqual({ ok: false, reason: "no-pane" });
});

test("answerSessionQuestion: no pane mapping → no-pane, sends nothing", async () => {
  const r = await answerSessionQuestion("ghost-session", 0);
  expect(r).toEqual({ ok: false, reason: "no-pane" });
});
