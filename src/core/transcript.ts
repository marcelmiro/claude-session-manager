/**
 * Transcript parsing (Contract B) — resolved conversational history only.
 *
 * Reads a Claude Code JSONL transcript into ordered `TranscriptTurn`s. Generalizes
 * the tail-read in `jsonl-reader.ts`. Per A5, conversational records have a
 * top-level `type` of `user` | `assistant`; everything else (mode, permission-mode,
 * last-prompt, ai-title, system, file-history-snapshot, attachment, …) is meta and
 * dropped. A record nests an Anthropic `message` whose `content` is either a string
 * (→ one text block) or an array of blocks.
 *
 * SCOPE (A3): pending interactions are NOT here — a tool awaiting approval has no
 * record until resolved. Pending data comes from the PreToolUse hook (Contract A).
 *
 * Tolerant by contract: unknown keys ignored, a truncated/half-written final line
 * is dropped (per-line try/parse). Forward-compat with claude minor versions.
 */

// Re-export so the contract test can import these from "./transcript".
export type { TranscriptBlock, TranscriptTurn } from "../types";
import type { TranscriptBlock, TranscriptTurn } from "../types";

interface RawBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

/** Parse a raw JSONL transcript into ordered turns (oldest first). */
export function parseTranscript(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated/half-written line — drop it
    }
    if (record.type !== "user" && record.type !== "assistant") continue;
    const content = record.message?.content;

    const blocks: TranscriptBlock[] =
      typeof content === "string"
        ? [{ type: "text", text: content }]
        : Array.isArray(content)
          ? (content as RawBlock[]).map(toBlock).filter((b): b is TranscriptBlock => b !== null)
          : [];

    turns.push({ role: record.type, content: blocks });
  }
  return turns;
}

/** The text of the last assistant turn that has any text content, else undefined. */
export function lastAssistantMessage(turns: TranscriptTurn[]): string | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    const text = turn.content
      .filter((b): b is Extract<TranscriptBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
    if (text) return text;
  }
  return undefined;
}

/** Map one raw content block to a typed `TranscriptBlock`, or null if unknown. */
function toBlock(block: RawBlock): TranscriptBlock | null {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text ?? "" };
    case "thinking":
      return { type: "thinking", text: block.thinking ?? "" };
    case "tool_use":
      return { type: "tool_use", id: block.id ?? "", name: block.name ?? "", input: block.input };
    case "tool_result":
      return { type: "tool_result", tool_use_id: block.tool_use_id ?? "", content: block.content };
    default:
      return null; // unknown block type — drop
  }
}
