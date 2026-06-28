/**
 * `transcriptToMessages` shaping (Inc5 preview). Pins the role sequence, the
 * tool_result→tool-use output pairing, and agreement with `lastAssistantMessage`.
 *
 * `home` helper first — importing preview-pane pulls in hook-events → config,
 * which freezes paths from $HOME.
 */

import "../../test/helpers/home";
import { test, expect } from "bun:test";
import { transcriptToMessages, renderMessage, updatePreview, type PreviewDeps } from "./preview-pane";
import { parseTranscript, lastAssistantMessage } from "../core/transcript";
import type { PendingToolCall } from "../core/jsonl-reader";
import type { Session } from "../types";
import { fixture } from "../../test/helpers/fixture";

const raw = fixture("transcripts/approved-tool.jsonl");
const turns = parseTranscript(raw);

const permProto = transcriptToMessages(parseTranscript(fixture("transcripts/permission-protocol.jsonl")));

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

test("a whole-line bracketed user turn is tagged system", () => {
  const marker = permProto.find((m) => m.text === "[Request interrupted by user for tool use]");
  expect(marker?.role).toBe("user");
  expect(marker?.system).toBe(true);
  // A normal user turn stays untagged.
  const normal = permProto.find((m) => m.role === "user" && m.text.startsWith("ask permission"));
  expect(normal?.system).toBeFalsy();
});

test("a tool-use whose paired tool_result is_error gets toolError", () => {
  const tool = permProto.find((m) => m.role === "tool-use");
  expect(tool?.toolNames).toContain("Write");
  expect(tool?.toolError).toBe(true);
});

test("renderMessage styles a system marker as a ⊘ event line, not a ❯ user message", () => {
  const marker = permProto.find((m) => m.system)!;
  const out = renderMessage(marker, 60);
  expect(out).toContain("⊘");
  expect(out).not.toContain("❯");
  expect(out).not.toContain("[");
});

test("renderMessage shows a denied tool with a ⊘ marker, suppressing the raw denial text", () => {
  const tool = permProto.find((m) => m.toolError)!;
  const out = renderMessage(tool, 60);
  expect(out).toContain("⊘");
  expect(out).toContain("denied");
  expect(out).not.toContain("doesn't want to proceed");
});

test("waiting preview renders history above the decision block and scrolls to bottom", async () => {
  const turns = parseTranscript(fixture("transcripts/permission-protocol.jsonl"));
  const pending: PendingToolCall = { name: "Bash", toolUseId: "toolu_x", command: "make all", description: "Run Makefile" };
  const deps: PreviewDeps = { readTurns: async () => turns, getPending: () => pending };

  let content = "";
  let scroll = -1;
  const box = {
    width: 60,
    setContent: (c: string) => { content = c; },
    setScrollPerc: (p: number) => { scroll = p; },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const session = {
    id: "perm-proto-0001", repoPath: "/tmp/x", repo: "x", branch: "main", status: "waiting",
  } as unknown as Session;

  const result = await updatePreview(box, session, { deps });

  expect(result).toBe(pending);
  expect(scroll).toBe(100); // decision at bottom, like Claude's scrollback

  // The decision block (its "Do you want to proceed?" + options) comes AFTER the
  // history turn from the transcript — i.e. it is the last content, not the first.
  const idxHistory = content.indexOf("ask permission again");
  const idxDecision = content.indexOf("Do you want to proceed?");
  expect(idxHistory).toBeGreaterThan(-1);
  expect(idxDecision).toBeGreaterThan(idxHistory);
  // The final option line closes the block.
  expect(content.trimEnd().endsWith("3. No{/#A0A0A0-fg}")).toBe(true);
});

test("truncateAtWord truncates on a word boundary (no mid-word cut)", () => {
  // Exercised through renderMessage on a long user message (user path truncates
  // at maxWidth*3, so a small width forces the cut).
  const long = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
  const out = renderMessage({ role: "user", text: long }, 10);
  expect(out).toContain("…");
  // Strip blessed tags + the "❯ " prefix to recover the visible, pre-ellipsis text.
  const visible = out
    .slice(0, out.indexOf("…"))
    .replace(/\{[^}]*\}/g, "")
    .replace(/^❯ /, "")
    .trimEnd();
  // It must be a whole-word prefix of the source — no letter sliced mid-word.
  expect(`${long} `.startsWith(`${visible} `)).toBe(true);
});
