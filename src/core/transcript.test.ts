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
  const ask = all.find((b) => b.type === "tool_use" && b.name === "AskUserQuestion");
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

test("tolerates a truncated last line and unknown keys", () => {
  const truncated = approved + '\n{"type":"assistant","message":{"role":"assista';
  expect(() => parseTranscript(truncated)).not.toThrow();
  // The valid turns are still recovered intact.
  expect(parseTranscript(truncated).map((t) => t.role)).toEqual(
    parseTranscript(approved).map((t) => t.role),
  );
});

test("returns the last assistant message", () => {
  expect(lastAssistantMessage(parseTranscript(approved))).toBe(
    "Done. Created `/tmp/spike-perm-test.txt`.",
  );
});
