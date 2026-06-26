/**
 * `transcriptToMessages` shaping (Inc5 preview). Pins the role sequence, the
 * tool_result→tool-use output pairing, and agreement with `lastAssistantMessage`.
 *
 * `home` helper first — importing preview-pane pulls in hook-events → config,
 * which freezes paths from $HOME.
 */

import "../../test/helpers/home";
import { test, expect } from "bun:test";
import { transcriptToMessages } from "./preview-pane";
import { parseTranscript, lastAssistantMessage } from "../core/transcript";
import { fixture } from "../../test/helpers/fixture";

const raw = fixture("transcripts/approved-tool.jsonl");
const turns = parseTranscript(raw);

test("role sequence is user, assistant, tool-use, assistant", () => {
  const messages = transcriptToMessages(turns);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool-use", "assistant"]);
});

test("tool_result output is paired onto the matching tool-use message", () => {
  const toolMsg = transcriptToMessages(turns).find((m) => m.role === "tool-use");
  expect(toolMsg).toBeDefined();
  expect(toolMsg!.toolNames).toContain("Bash");
  // The user-turn tool_result for this tool_use_id flows into bashOutput.
  expect(toolMsg!.bashOutput && toolMsg!.bashOutput.length).toBeGreaterThan(0);
});

test("preview's last assistant message equals lastAssistantMessage(parseTranscript)", () => {
  const messages = transcriptToMessages(turns);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  expect(lastAssistant?.text).toBe(lastAssistantMessage(turns));
});
