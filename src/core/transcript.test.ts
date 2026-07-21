/**
 * Contract B — transcript parsing (resolved history only).
 *
 * RED ON PURPOSE: this imports `./transcript`, which Impl #2 creates. Until then
 * the import fails and this file alone goes red; the rest of the suite still
 * runs. DO NOT create `transcript.ts` here — its absence is the deliverable and
 * these assertions ARE Impl #2's spec.
 *
 * This file pins transcript.ts's contract:
 *
 *   parseTranscript(raw: string): TranscriptTurn[]   // ordered conversational turns
 *   lastAssistantMessage(turns: TranscriptTurn[]): string | undefined
 *
 * A TranscriptTurn is { role: "user" | "assistant", content: TranscriptBlock[] }
 * where each block carries its `type` plus the block-specific fields below.
 *
 * SCOPE (A3): pending interactions are NOT in the transcript — a tool awaiting
 * approval or an unanswered question has no record until resolved. Pending
 * `{pending, tool, input}` / pending-question data is sourced from the PreToolUse
 * hook (Contract A), not here. Contract B covers resolved history only.
 */

import { test, expect } from "bun:test";
import {
  parseTranscript,
  parseActiveBranch,
  lastAssistantMessage,
  type TranscriptBlock,
  type TranscriptTurn,
} from "./transcript";
import { fixture } from "../../test/helpers/fixture";

const approved = fixture("transcripts/approved-tool.jsonl");
const askUserQuestion = fixture("transcripts/askuserquestion.jsonl");

function blocks(turns: TranscriptTurn[]): TranscriptBlock[] {
  return turns.flatMap((t) => t.content);
}

test("parses ordered turns from user/assistant records, ignoring meta types", () => {
  const turns = parseTranscript(approved);
  // mode / permission-mode / last-prompt / ai-title / system records are dropped.
  expect(turns.map((t) => t.role)).toEqual([
    "user", // the prompt
    "assistant", // "I'll run that command."
    "assistant", // tool_use
    "user", // tool_result
    "assistant", // "Done. Created ..."
  ]);
});

test("surfaces text/thinking/tool_use/tool_result blocks via message.content[]", () => {
  const all = blocks(parseTranscript(approved));
  const types = new Set(all.map((b) => b.type));
  expect(types.has("text")).toBe(true);
  expect(types.has("tool_use")).toBe(true);
  expect(types.has("tool_result")).toBe(true);
});

test("a resolved tool surfaces as a tool_use/tool_result pair matched by tool_use_id", () => {
  const all = blocks(parseTranscript(approved));
  const toolUse = all.find((b) => b.type === "tool_use");
  const toolResult = all.find((b) => b.type === "tool_result");
  expect(toolUse?.id).toBe("toolu_01LqXQE97KmTJoTDuPPqkBLA");
  expect(toolResult?.tool_use_id).toBe(toolUse?.id);
});

test("AskUserQuestion tool_use.input surfaces as { questions: [...] } (plural, A4)", () => {
  const all = blocks(parseTranscript(askUserQuestion));
  const ask = all.find(
    (b): b is Extract<TranscriptBlock, { type: "tool_use" }> =>
      b.type === "tool_use" && b.name === "AskUserQuestion",
  );
  const input = ask?.input as {
    questions: { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] }[];
  };
  expect(Array.isArray(input.questions)).toBe(true);
  const q = input.questions[0];
  expect(typeof q.question).toBe("string");
  expect(typeof q.header).toBe("string");
  expect(typeof q.multiSelect).toBe("boolean");
  expect(typeof q.options[0].label).toBe("string");
  expect(typeof q.options[0].description).toBe("string");
});

test("propagates is_error from a tool_result block (denial/error styling hook)", () => {
  const raw =
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_x","is_error":true,"content":"rejected"}]}}';
  const all = blocks(parseTranscript(raw));
  const result = all.find((b) => b.type === "tool_result");
  expect(result?.type === "tool_result" && result.is_error).toBe(true);
});

test("image block parses to a byte-free marker (drops the base64 source)", () => {
  const raw =
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Image #1] look"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAAconst-big-base64"}}]}}';
  const all = blocks(parseTranscript(raw));
  const img = all.find((b) => b.type === "image");
  expect(img).toEqual({ type: "image" }); // no `source`/`data`
  expect(JSON.stringify(parseTranscript(raw))).not.toContain("base64");
});

test("tolerates a truncated last line and unknown keys", () => {
  const truncated = approved + '\n{"type":"assistant","message":{"role":"assista';
  expect(() => parseTranscript(truncated)).not.toThrow();
  // The valid turns are still recovered intact.
  expect(parseTranscript(truncated).map((t) => t.role)).toEqual(
    parseTranscript(approved).map((t) => t.role),
  );
});

test("drops slash-command runner records (/compact, /clear) as plumbing", () => {
  const raw = [
    '{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: ...</local-command-caveat>"}}',
    '{"type":"user","message":{"role":"user","content":"<command-name>/compact</command-name>\\n  <command-message>compact</command-message>\\n  <command-args></command-args>"}}',
    '{"type":"system","subtype":"local_command","content":"<local-command-stdout></local-command-stdout>"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Compacted."}]}}',
  ].join("\n");
  const turns = parseTranscript(raw);
  expect(turns.map((t) => t.role)).toEqual(["assistant"]);
  expect(lastAssistantMessage(turns)).toBe("Compacted.");
});

test("drops isMeta user records (e.g. skill base-directory injection)", () => {
  const raw = [
    '{"type":"user","isMeta":true,"message":{"role":"user","content":"Base directory for this skill: /x\\n\\n# Skill"}}',
    '{"type":"user","message":{"role":"user","content":"real prompt"}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}',
  ].join("\n");
  const turns = parseTranscript(raw);
  expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(turns)).not.toContain("Base directory");
});

test("drops async-subagent <task-notification> user records", () => {
  const raw = [
    '{"type":"user","message":{"role":"user","content":"go"}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"launching"}]}}',
    '{"type":"user","message":{"role":"user","content":"<task-notification>\\n<status>completed</status>\\n</task-notification>"}}',
  ].join("\n");
  const turns = parseTranscript(raw);
  expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(turns)).not.toContain("task-notification");
});

test("flags the post-compaction summary record (isCompactSummary) keeping its text", () => {
  const raw = [
    '{"type":"user","message":{"role":"user","content":"earlier prompt"}}',
    '{"type":"user","isCompactSummary":true,"isVisibleInTranscriptOnly":true,"message":{"role":"user","content":"This session is being continued from a previous conversation...\\n\\nSummary: did X."}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"continuing"}]}}',
  ].join("\n");
  const turns = parseTranscript(raw);
  expect(turns.map((t) => t.role)).toEqual(["user", "user", "assistant"]);
  expect(turns[1].compactSummary).toBe(true);
  expect(turns[1].content).toEqual([
    { type: "text", text: "This session is being continued from a previous conversation...\n\nSummary: did X." },
  ]);
  // Ordinary turns carry no flag.
  expect(turns[0].compactSummary).toBeUndefined();
  expect(turns[2].compactSummary).toBeUndefined();
});

test("returns the last assistant message", () => {
  expect(lastAssistantMessage(parseTranscript(approved))).toBe(
    "Done. Created `/tmp/spike-perm-test.txt`.",
  );
});

// --- parseActiveBranch: the JSONL is a tree; only the active leaf→root path is shown ---

// Build a conversational JSONL record with explicit tree links.
function rec(opts: {
  uuid: string;
  parentUuid: string | null;
  role: "user" | "assistant";
  text: string;
  isSidechain?: boolean;
}): string {
  return JSON.stringify({
    type: opts.role,
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    ...(opts.isSidechain ? { isSidechain: true } : {}),
    message: { role: opts.role, content: [{ type: "text", text: opts.text }] },
  });
}

function texts(turns: TranscriptTurn[]): string[] {
  return turns.flatMap((t) =>
    t.content
      .filter((b): b is Extract<TranscriptBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text),
  );
}

test("parseActiveBranch follows the active leaf→root path (oldest first)", () => {
  const raw = [
    rec({ uuid: "a", parentUuid: null, role: "user", text: "first" }),
    rec({ uuid: "b", parentUuid: "a", role: "assistant", text: "reply" }),
    rec({ uuid: "c", parentUuid: "b", role: "user", text: "second" }),
  ].join("\n");
  expect(texts(parseActiveBranch(raw))).toEqual(["first", "reply", "second"]);
});

test("parseActiveBranch excludes abandoned (rewound/edited) branches", () => {
  // User rewinds after "b" and re-sends: "c-old" is abandoned; the new branch is a→b→d.
  // A linear read would show both "c-old" and "d"; the active branch shows only "d".
  const raw = [
    rec({ uuid: "a", parentUuid: null, role: "user", text: "first" }),
    rec({ uuid: "b", parentUuid: "a", role: "assistant", text: "reply" }),
    rec({ uuid: "c-old", parentUuid: "b", role: "user", text: "abandoned" }),
    rec({ uuid: "d", parentUuid: "b", role: "user", text: "kept" }),
  ].join("\n");
  expect(texts(parseTranscript(raw))).toEqual(["first", "reply", "abandoned", "kept"]);
  expect(texts(parseActiveBranch(raw))).toEqual(["first", "reply", "kept"]);
});

test("parseActiveBranch drops subagent sidechain turns", () => {
  // A sidechain branches off "a" but is never an ancestor of the main leaf "c".
  const raw = [
    rec({ uuid: "a", parentUuid: null, role: "user", text: "main prompt" }),
    rec({ uuid: "s1", parentUuid: "a", role: "user", text: "subagent prompt", isSidechain: true }),
    rec({ uuid: "s2", parentUuid: "s1", role: "assistant", text: "subagent reply", isSidechain: true }),
    rec({ uuid: "b", parentUuid: "a", role: "assistant", text: "main reply" }),
    rec({ uuid: "c", parentUuid: "b", role: "user", text: "follow up" }),
  ].join("\n");
  expect(texts(parseActiveBranch(raw))).toEqual(["main prompt", "main reply", "follow up"]);
});

// --- queued_command prompt attachments (messages consumed from the queue mid-turn) ---

// Mirrors the real record shape: a message sent mid-turn and consumed inside a tool loop
// never becomes a `user` record — only this attachment, on the active branch.
function queuedRec(opts: {
  uuid: string;
  parentUuid: string | null;
  prompt: string;
  commandMode?: string;
  origin?: boolean;
}): string {
  return JSON.stringify({
    type: "attachment",
    uuid: opts.uuid,
    parentUuid: opts.parentUuid,
    isSidechain: false,
    attachment: {
      type: "queued_command",
      prompt: opts.prompt,
      commandMode: opts.commandMode ?? "prompt",
      ...(opts.origin === false ? {} : { origin: { kind: "human" } }),
      timestamp: "2026-07-20T21:37:49.924Z",
    },
  });
}

test("a queued_command prompt attachment becomes a user turn flagged queued", () => {
  const turns = parseTranscript(queuedRec({ uuid: "q", parentUuid: null, prompt: "queued msg" }));
  expect(turns).toEqual([
    { role: "user", content: [{ type: "text", text: "queued msg" }], queued: true },
  ]);
});

test("prompt-mode without origin still maps; task-notification mode stays dropped", () => {
  // 2 of 69 prompt-mode records in real history lack `origin` — commandMode is the gate.
  expect(
    parseTranscript(queuedRec({ uuid: "q", parentUuid: null, prompt: "no origin", origin: false })),
  ).toHaveLength(1);
  expect(
    parseTranscript(
      queuedRec({
        uuid: "q",
        parentUuid: null,
        prompt: "<task-notification>\n<task-id>b1</task-id>",
        commandMode: "task-notification",
      }),
    ),
  ).toHaveLength(0);
});

test("parseActiveBranch walks through a queued attachment, mid-chain and as leaf", () => {
  // Mid-chain: the next assistant record parents onto the attachment's uuid.
  const midChain = [
    rec({ uuid: "a", parentUuid: null, role: "user", text: "first" }),
    rec({ uuid: "b", parentUuid: "a", role: "assistant", text: "working" }),
    queuedRec({ uuid: "q", parentUuid: "b", prompt: "queued msg" }),
    rec({ uuid: "c", parentUuid: "q", role: "assistant", text: "done" }),
  ].join("\n");
  expect(texts(parseActiveBranch(midChain))).toEqual(["first", "working", "queued msg", "done"]);

  // As leaf: between the queue's `remove` and the next assistant append, the attachment
  // is the deepest node — it must be leaf-eligible or the message vanishes for one poll.
  const asLeaf = [
    rec({ uuid: "a", parentUuid: null, role: "user", text: "first" }),
    rec({ uuid: "b", parentUuid: "a", role: "assistant", text: "working" }),
    queuedRec({ uuid: "q", parentUuid: "b", prompt: "queued msg" }),
  ].join("\n");
  expect(texts(parseActiveBranch(asLeaf))).toEqual(["first", "working", "queued msg"]);

  // A task-notification attachment is NOT leaf-eligible — the branch stays put.
  const notifLeaf = `${asLeaf}\n${queuedRec({ uuid: "n", parentUuid: "q", prompt: "<task-notification>x", commandMode: "task-notification" })}`;
  expect(texts(parseActiveBranch(notifLeaf))).toEqual(["first", "working", "queued msg"]);
});

test("parseActiveBranch stops at a broken parent link, keeping the intact suffix", () => {
  // "a" references a parent that was never written (e.g. dropped/rotated head): the walk
  // stops rather than crashing, yielding the deepest recoverable suffix.
  const raw = [
    rec({ uuid: "a", parentUuid: "missing", role: "user", text: "orphaned head" }),
    rec({ uuid: "b", parentUuid: "a", role: "assistant", text: "reply" }),
  ].join("\n");
  expect(texts(parseActiveBranch(raw))).toEqual(["orphaned head", "reply"]);
});

test("parseActiveBranch on a well-formed linear log matches parseTranscript", () => {
  const raw = [
    rec({ uuid: "a", parentUuid: null, role: "user", text: "first" }),
    rec({ uuid: "b", parentUuid: "a", role: "assistant", text: "reply" }),
    rec({ uuid: "c", parentUuid: "b", role: "user", text: "second" }),
  ].join("\n");
  expect(parseActiveBranch(raw)).toEqual(parseTranscript(raw));
});

test("parseActiveBranch falls back to linear for pre-tree logs (no uuid records)", () => {
  // The approved fixture's conversational records pre-date / omit a usable tree in a way
  // that should still render: with no active leaf, fall back to the linear parse.
  const noUuid =
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n' +
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}';
  expect(parseActiveBranch(noUuid)).toEqual(parseTranscript(noUuid));
  expect(texts(parseActiveBranch(noUuid))).toEqual(["hi", "hello"]);
});

test("parseActiveBranch handles an empty/meta-only log", () => {
  expect(parseActiveBranch("")).toEqual([]);
  expect(parseActiveBranch('{"type":"system","subtype":"x"}')).toEqual([]);
});
