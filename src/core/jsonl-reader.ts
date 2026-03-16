/**
 * JSONL session file reader for preview rendering.
 * Reads structured messages from Claude Code session files and returns
 * them in a format suitable for markdown rendering at any width.
 */

export interface PreviewMessage {
  role: "user" | "assistant" | "tool-use";
  /** Raw markdown text (assistant text blocks, user prompts) */
  text: string;
  /** Tool names used in this turn (for tool-use messages) */
  toolNames?: string[];
  /** Bash command output from progress entries */
  bashOutput?: string;
  /** Thinking block text (truncated) */
  thinking?: string;
}

interface JsonlEntry {
  type?: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
    stop_reason?: string | null;
  };
  data?: {
    type?: string;
    fullOutput?: string;
  };
  parentToolUseID?: string;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  content?: string | ContentBlock[];
  is_error?: boolean;
  tool_use_id?: string;
}

/**
 * Read the last N conversation messages from a JSONL session file.
 * Reconstructs multi-entry assistant turns by grouping on message.id.
 * Returns messages in chronological order (oldest first).
 */
export async function readPreviewMessages(
  sessionPath: string,
  messageCount = 3,
): Promise<PreviewMessage[]> {
  try {
    const file = Bun.file(sessionPath);
    const stat = await file.stat();
    if (!stat) return [];

    // Read more for context — need enough lines to find N conversation messages
    const TAIL_SIZE = 64 * 1024;
    const offset = Math.max(0, stat.size - TAIL_SIZE);
    const chunk = await file.slice(offset, stat.size).text();
    const rawLines = chunk.trim().split("\n").filter(Boolean);

    // Skip first line if we sliced mid-file (likely truncated JSON)
    const startIdx = offset > 0 ? 1 : 0;

    // Parse all entries
    const entries: JsonlEntry[] = [];
    for (let i = startIdx; i < rawLines.length; i++) {
      try {
        entries.push(JSON.parse(rawLines[i]));
      } catch {
        continue;
      }
    }

    // Collect bash_progress fullOutput keyed by parentToolUseID
    const bashOutputs = new Map<string, string>();
    for (const entry of entries) {
      if (
        entry.type === "progress" &&
        entry.data?.type === "bash_progress" &&
        entry.data.fullOutput &&
        entry.parentToolUseID
      ) {
        bashOutputs.set(entry.parentToolUseID, entry.data.fullOutput);
      }
    }

    // Build conversation messages from entries
    // Group assistant entries by message.id to reconstruct full turns
    const conversationMessages: PreviewMessage[] = [];
    const assistantTurns = new Map<
      string,
      { text: string; toolNames: string[]; toolUseIds: string[]; thinking: string; index: number }
    >();

    for (const entry of entries) {
      const msg = entry.message;
      if (!msg) continue;

      if (msg.role === "user") {
        // Flush any pending assistant turn
        flushAssistantTurns(assistantTurns, conversationMessages, bashOutputs);

        const content = msg.content;
        if (typeof content === "string" && content.trim()) {
          // Direct user prompt
          conversationMessages.push({ role: "user", text: content.trim() });
        } else if (Array.isArray(content)) {
          // User messages with tool results — only extract actual user text
          // Tool results are skipped (bash output is already on the tool-use message)
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              conversationMessages.push({ role: "user", text: block.text.trim() });
            }
          }
        }
      } else if (msg.role === "assistant") {
        const msgId = msg.id || `anon-${entries.indexOf(entry)}`;
        let turn = assistantTurns.get(msgId);
        if (!turn) {
          turn = { text: "", toolNames: [], toolUseIds: [], thinking: "", index: conversationMessages.length };
          assistantTurns.set(msgId, turn);
        }

        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              turn.text += (turn.text ? "\n\n" : "") + block.text;
            } else if (block.type === "thinking" && block.thinking) {
              turn.thinking = block.thinking;
            } else if (block.type === "tool_use" && block.name) {
              turn.toolNames.push(block.name);
              if (block.id) turn.toolUseIds.push(block.id);
            }
          }
        }
      }
    }

    // Flush remaining assistant turn
    flushAssistantTurns(assistantTurns, conversationMessages, bashOutputs);

    // Return last N messages, but always include context:
    // Walk backwards to find the last N user/assistant messages (skip tool-results that are standalone)
    const result: PreviewMessage[] = [];
    let collected = 0;
    for (let i = conversationMessages.length - 1; i >= 0 && collected < messageCount; i--) {
      const m = conversationMessages[i];
      result.unshift(m);
      // Count user and assistant messages toward the limit, not tool-results
      if (m.role === "user" || m.role === "assistant" || m.role === "tool-use") {
        collected++;
      }
    }

    return result;
  } catch {
    return [];
  }
}

function flushAssistantTurns(
  turns: Map<string, { text: string; toolNames: string[]; toolUseIds: string[]; thinking: string; index: number }>,
  messages: PreviewMessage[],
  bashOutputs: Map<string, string>,
): void {
  // Sort by insertion index to maintain order
  const sorted = [...turns.values()].sort((a, b) => a.index - b.index);
  for (const turn of sorted) {
    // Add thinking as part of the message if present
    const thinking = turn.thinking
      ? turn.thinking.replace(/\s+/g, " ").trim()
      : undefined;

    if (turn.text) {
      messages.push({
        role: "assistant",
        text: turn.text,
        thinking,
      });
    }

    if (turn.toolNames.length > 0) {
      // Collect bash outputs for tools in this turn
      const outputs: string[] = [];
      for (const id of turn.toolUseIds) {
        const out = bashOutputs.get(id);
        if (out) outputs.push(out);
      }

      messages.push({
        role: "tool-use",
        text: "",
        toolNames: turn.toolNames,
        bashOutput: outputs.length > 0 ? outputs.join("\n") : undefined,
        thinking: !turn.text ? thinking : undefined, // Only attach thinking to tool-use if no text message was emitted
      });
    }
  }
  turns.clear();
}
