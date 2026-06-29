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
  is_error?: boolean;
}

/**
 * Slash-command runner records (`/compact`, `/clear`, …). Claude Code emits these
 * as `user` turns wrapped in reserved tags and renders them as a command pill, not
 * raw text. We drop them so the transcript shows conversation, not the plumbing.
 */
const LOCAL_COMMAND_META =
  /^\s*<(?:local-command-caveat|local-command-stdout|command-name|command-message|command-args|command-contents)>/;

/** A parsed conversational record: the turn plus the tree links used to rebuild a branch. */
interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

/**
 * Convert a conversational record (`type` of `user`/`assistant`) to a `TranscriptTurn`,
 * or null when it carries no visible content (pure local-command plumbing). A genuinely
 * empty turn (no blocks to begin with) is preserved as `{ content: [] }`.
 */
function recordToTurn(record: RawRecord): TranscriptTurn | null {
  if (record.type !== "user" && record.type !== "assistant") return null;
  const content = record.message?.content;

  const blocks: TranscriptBlock[] =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? (content as RawBlock[]).map(toBlock).filter((b): b is TranscriptBlock => b !== null)
        : [];

  const visible = blocks.filter(
    (b) => !(b.type === "text" && LOCAL_COMMAND_META.test(b.text)),
  );
  if (visible.length === 0 && blocks.length > 0) return null;

  return { role: record.type, content: visible };
}

/** Parse a raw JSONL transcript into ordered turns (oldest first), in file order. */
export function parseTranscript(raw: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: RawRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated/half-written line — drop it
    }
    const turn = recordToTurn(record);
    if (turn) turns.push(turn);
  }
  return turns;
}

/**
 * Parse a raw JSONL transcript into the turns of its ACTIVE conversation branch only.
 *
 * Claude Code's JSONL is a tree, not a linear log: a rewind or edit-and-resend appends a
 * NEW branch (its first record's `parentUuid` points back at an earlier message) while the
 * abandoned branch's records stay in the file. The terminal renders only the active branch
 * — the path from the latest leaf back to the root — so a linear read (`parseTranscript`)
 * shows abandoned-branch and subagent (`isSidechain`) turns the user never committed.
 *
 * Reconstruct that path: index records by `uuid`, take the LAST non-sidechain
 * conversational record as the active leaf (Claude writes the live tip last), then walk
 * `parentUuid` to the root and reverse to oldest-first. Sidechain turns fall out naturally
 * (they branch off the main line and are never ancestors of the main leaf); we also skip
 * any sidechain record defensively. A broken parent link (missing uuid) just stops the
 * walk, yielding the deepest intact suffix rather than crashing.
 */
export function parseActiveBranch(raw: string): TranscriptTurn[] {
  const byId = new Map<string, RawRecord>();
  let leaf: string | null = null;
  let sawConversational = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: RawRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // truncated/half-written line — drop it
    }
    if (typeof record.uuid === "string") byId.set(record.uuid, record);
    const conversational = record.type === "user" || record.type === "assistant";
    if (conversational) sawConversational = true;
    if (conversational && !record.isSidechain && typeof record.uuid === "string") {
      leaf = record.uuid; // newest wins — the active tip is written last
    }
  }

  // Pre-tree logs (no `uuid` on any conversational record) carry no branch to rebuild —
  // fall back to the linear read so they still render rather than coming back empty.
  if (!leaf && sawConversational) return parseTranscript(raw);

  const chain: RawRecord[] = [];
  const seen = new Set<string>();
  for (let id: string | null = leaf; id && byId.has(id) && !seen.has(id); ) {
    seen.add(id);
    const record = byId.get(id)!;
    if (!record.isSidechain) chain.push(record);
    id = typeof record.parentUuid === "string" ? record.parentUuid : null;
  }
  chain.reverse(); // walked leaf→root; emit oldest-first

  const turns: TranscriptTurn[] = [];
  for (const record of chain) {
    const turn = recordToTurn(record);
    if (turn) turns.push(turn);
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
      return { type: "tool_result", tool_use_id: block.tool_use_id ?? "", content: block.content, is_error: block.is_error };
    case "image":
      return { type: "image" }; // drop the (large base64) source — keep only a marker
    default:
      return null; // unknown block type — drop
  }
}
