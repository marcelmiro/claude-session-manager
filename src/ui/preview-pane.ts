import { homedir } from "os";
import type { Widgets } from "blessed";
import type { Session } from "../types";

import type { PreviewMessage, PendingToolCall, ToolInput } from "../core/jsonl-reader";
import { readTranscriptTurns, pendingToolCall } from "../core/hook-events";
import type { TranscriptTurn } from "../core/transcript";
import { formatTimeAgo } from "../core/status";
import { markdownToBlessed } from "./markdown";
import { C } from "./colors";

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

/** Escape blessed tag characters in text */
function esc(text: string): string {
  return text.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
}

// -- Plain text extraction (for clipboard copy) --

/** Last preview content as plain text (markdown source) */
let lastPlainText = "";

export function getPreviewPlainText(): string {
  return lastPlainText;
}

// -- ANSI → blessed (kept for non-JSONL contexts like wizard preview) --

const BASIC_COLORS = [
  "#000000", "#AA0000", "#00AA00", "#AA5500",
  "#0000AA", "#AA00AA", "#00AAAA", "#AAAAAA",
];
const BRIGHT_COLORS = [
  "#555555", "#FF5555", "#55FF55", "#FFFF55",
  "#5555FF", "#FF55FF", "#55FFFF", "#FFFFFF",
];

function color256ToHex(n: number): string {
  if (n < 8) return BASIC_COLORS[n];
  if (n < 16) return BRIGHT_COLORS[n - 8];
  if (n < 232) {
    const idx = n - 16;
    const vals = [0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    const r = vals[Math.floor(idx / 36)];
    const g = vals[Math.floor((idx % 36) / 6)];
    const b = vals[idx % 6];
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }
  const v = 8 + (n - 232) * 10;
  const h = Math.min(v, 255).toString(16).padStart(2, "0");
  return `#${h}${h}${h}`;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${(r & 0xff).toString(16).padStart(2, "0")}${(g & 0xff).toString(16).padStart(2, "0")}${(b & 0xff).toString(16).padStart(2, "0")}`;
}

interface TermStyle {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
}

function openTags(s: TermStyle): string {
  let t = "";
  if (s.fg) t += `{${s.fg}-fg}`;
  if (s.bg) t += `{${s.bg}-bg}`;
  if (s.bold) t += "{bold}";
  if (s.italic) t += "{italic}";
  return t;
}

function closeTags(s: TermStyle): string {
  let t = "";
  if (s.italic) t += "{/italic}";
  if (s.bold) t += "{/bold}";
  if (s.bg) t += `{/${s.bg}-bg}`;
  if (s.fg) t += `{/${s.fg}-fg}`;
  return t;
}

function stripNonSgrAnsi(text: string): string {
  return text
    .replace(/\x1b\[([0-9;?]*)([\x40-\x7e])/g, (match, _params, final) =>
      final === "m" ? match : "",
    )
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b(?!\[)[\x20-\x2f]*[\x30-\x7e]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, "");
}

function processSgr(params: string, state: TermStyle): string {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  let out = "";
  let i = 0;

  while (i < codes.length) {
    const c = codes[i];

    if (c === 0) {
      out += closeTags(state);
      state.fg = state.bg = null;
      state.bold = state.italic = false;
    } else if (c === 1) {
      if (!state.bold) { out += "{bold}"; state.bold = true; }
    } else if (c === 3) {
      if (!state.italic) { out += "{italic}"; state.italic = true; }
    } else if (c === 22) {
      if (state.bold) { out += "{/bold}"; state.bold = false; }
    } else if (c === 23) {
      if (state.italic) { out += "{/italic}"; state.italic = false; }
    } else if (c >= 30 && c <= 37) {
      const hex = BASIC_COLORS[c - 30];
      if (state.fg) out += `{/${state.fg}-fg}`;
      state.fg = hex;
      out += `{${hex}-fg}`;
    } else if (c === 39) {
      if (state.fg) { out += `{/${state.fg}-fg}`; state.fg = null; }
    } else if (c >= 40 && c <= 47) {
      const hex = BASIC_COLORS[c - 40];
      if (state.bg) out += `{/${state.bg}-bg}`;
      state.bg = hex;
      out += `{${hex}-bg}`;
    } else if (c === 49) {
      if (state.bg) { out += `{/${state.bg}-bg}`; state.bg = null; }
    } else if (c >= 90 && c <= 97) {
      const hex = BRIGHT_COLORS[c - 90];
      if (state.fg) out += `{/${state.fg}-fg}`;
      state.fg = hex;
      out += `{${hex}-fg}`;
    } else if (c >= 100 && c <= 107) {
      const hex = BRIGHT_COLORS[c - 100];
      if (state.bg) out += `{/${state.bg}-bg}`;
      state.bg = hex;
      out += `{${hex}-bg}`;
    } else if (c === 38 || c === 48) {
      const isFg = c === 38;
      if (codes[i + 1] === 2 && i + 4 < codes.length) {
        const hex = rgbToHex(codes[i + 2], codes[i + 3], codes[i + 4]);
        if (isFg) {
          if (state.fg) out += `{/${state.fg}-fg}`;
          state.fg = hex;
          out += `{${hex}-fg}`;
        } else {
          if (state.bg) out += `{/${state.bg}-bg}`;
          state.bg = hex;
          out += `{${hex}-bg}`;
        }
        i += 4;
      } else if (codes[i + 1] === 5 && i + 2 < codes.length) {
        const hex = color256ToHex(codes[i + 2]);
        if (isFg) {
          if (state.fg) out += `{/${state.fg}-fg}`;
          state.fg = hex;
          out += `{${hex}-fg}`;
        } else {
          if (state.bg) out += `{/${state.bg}-bg}`;
          state.bg = hex;
          out += `{${hex}-bg}`;
        }
        i += 2;
      }
    }

    i++;
  }

  return out;
}

function convertLine(line: string, state: TermStyle): string {
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  let result = openTags(state);

  for (const part of parts) {
    const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!sgr) {
      result += part.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
      continue;
    }
    result += processSgr(sgr[1], state);
  }

  result += closeTags(state);
  return result;
}

export function ansiToBlessedMarkup(text: string): string {
  const cleaned = stripNonSgrAnsi(text);
  const lines = cleaned.split("\n");
  const state: TermStyle = { fg: null, bg: null, bold: false, italic: false };
  return lines.map((line) => convertLine(line, state)).join("\n");
}

// -- JSONL-based preview rendering --

/** How many trailing transcript messages to render (scroll-to-bottom keeps the
 *  most recent visible; older context is reachable by scrolling up). */
const PREVIEW_MSG_LIMIT = 8;

/** Resolve the JSONL path for a session */
export function getSessionPath(session: Session): string | null {
  if (!session.id) return null;
  const encodedPath = encodeProjectPath(session.repoPath);
  return `${homedir()}/.claude/projects/${encodedPath}/${session.id}.jsonl`;
}

// -- transcript.ts → PreviewMessage adapter (Inc5) --
// The preview now sources from the JSONL transcript via `transcript.ts` (the
// contract parser). These adapters map `TranscriptTurn[]` into the existing
// `PreviewMessage`/`ToolInput` shapes so the render helpers below are unchanged.

/** Extract a tool_use block's structured input into a `ToolInput`. */
function toolInputFrom(name: string, input: unknown): ToolInput {
  const inp = (input ?? {}) as Record<string, any>;
  const ti: ToolInput = { name };
  if (typeof inp.file_path === "string") ti.filePath = inp.file_path;
  if (typeof inp.command === "string") ti.command = inp.command;
  if (typeof inp.description === "string") ti.description = inp.description;
  if (typeof inp.pattern === "string") ti.pattern = inp.pattern;
  if (name === "Edit") {
    if (typeof inp.old_string === "string") ti.oldString = inp.old_string;
    if (typeof inp.new_string === "string") ti.newString = inp.new_string;
  } else if (name === "Write") {
    if (typeof inp.content === "string") ti.content = inp.content.slice(0, 500);
  } else if (name === "AskUserQuestion" && inp.questions?.[0]) {
    const q = inp.questions[0];
    ti.question = {
      header: q.header || "",
      text: q.question || "",
      options: (q.options || []).map((o: any) => ({ label: o.label || "", description: o.description })),
      multiSelect: q.multiSelect || false,
    };
  }
  return ti;
}

/** Flatten a tool_result block's content to display text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("").trim();
  }
  return "";
}

/** Adapt parsed transcript turns into renderable PreviewMessages (chronological). */
export function transcriptToMessages(turns: TranscriptTurn[]): PreviewMessage[] {
  const messages: PreviewMessage[] = [];
  const toolMsgById = new Map<string, PreviewMessage>(); // tool_use_id → its tool-use message

  for (const turn of turns) {
    if (turn.role === "user") {
      for (const b of turn.content) {
        if (b.type === "text" && b.text.trim()) {
          const text = b.text.trim();
          // A whole-line bracketed marker (e.g. "[Request interrupted by user…]")
          // is a system event, not a real user turn.
          const system = /^\[.*\]$/.test(text);
          messages.push({ role: "user", text, system });
        } else if (b.type === "tool_result") {
          // Attach the result output to the matching tool-use message. A denied/
          // errored result flags the tool-use so the renderer styles it as an event.
          const tm = toolMsgById.get(b.tool_use_id);
          if (tm && b.is_error) tm.toolError = true;
          const out = toolResultText(b.content);
          if (tm && out) tm.bashOutput = tm.bashOutput ? `${tm.bashOutput}\n${out}` : out;
        }
      }
      continue;
    }

    // assistant turn: split into an optional text message + an optional tool-use message
    let text = "";
    let thinking: string | undefined;
    const toolNames: string[] = [];
    const toolInputs: ToolInput[] = [];
    const toolUseIds: string[] = [];
    for (const b of turn.content) {
      if (b.type === "text" && b.text) text += (text ? "\n\n" : "") + b.text;
      else if (b.type === "thinking" && b.text) thinking = b.text;
      else if (b.type === "tool_use") {
        toolNames.push(b.name);
        toolUseIds.push(b.id);
        toolInputs.push(toolInputFrom(b.name, b.input));
      }
    }
    if (text) messages.push({ role: "assistant", text, thinking });
    if (toolNames.length > 0) {
      const toolMsg: PreviewMessage = {
        role: "tool-use",
        text: "",
        toolNames,
        toolInputs,
        thinking: text ? undefined : thinking,
      };
      messages.push(toolMsg);
      for (const id of toolUseIds) toolMsgById.set(id, toolMsg);
    }
  }
  return messages;
}

/** Render a single PreviewMessage to blessed markup at the given width */
export function renderMessage(msg: PreviewMessage, maxWidth: number): string {
  const parts: string[] = [];

  // Thinking block — truncated, dimmed
  if (msg.thinking) {
    const truncated = msg.thinking.length > 120
      ? msg.thinking.slice(0, 119) + "…"
      : msg.thinking;
    parts.push(`{${C.dim}-fg}{italic}${esc(truncated)}{/italic}{/${C.dim}-fg}`);
  }

  switch (msg.role) {
    case "user": {
      const text = msg.text.replace(/\n/g, " ").trim();
      if (msg.system) {
        // System marker — compact dim event line, brackets stripped, no ❯.
        const inner = text.replace(/^\[/, "").replace(/\]$/, "").trim();
        parts.push(`{${C.dim}-fg}⊘ ${esc(truncateAtWord(inner, maxWidth - 4))}{/${C.dim}-fg}`);
        break;
      }
      // User message — dimmed with ❯ prefix
      const truncated = truncateAtWord(text, maxWidth * 3); // Allow a few lines
      parts.push(`{${C.dim}-fg}❯ ${esc(truncated)}{/${C.dim}-fg}`);
      break;
    }

    case "assistant": {
      // Full markdown rendering at target width
      parts.push(markdownToBlessed(msg.text, maxWidth));
      break;
    }

    case "tool-use": {
      // Show tool input details when available
      if (msg.toolInputs && msg.toolInputs.length > 0) {
        for (const ti of msg.toolInputs) {
          if (ti.command) {
            // Bash: show command
            const cmd = truncateAtWord(ti.command, maxWidth - 6);
            parts.push(`{${C.dim}-fg}  ↳ ${esc(ti.name)}{/${C.dim}-fg}`);
            parts.push(`{${C.peach}-fg}    $ ${esc(cmd)}{/${C.peach}-fg}`);
          } else if (ti.filePath) {
            // Edit/Write: show file path (keep the end visible — no word boundaries)
            const fp = ti.filePath.length > maxWidth - 6
              ? "…" + ti.filePath.slice(-(maxWidth - 7))
              : ti.filePath;
            parts.push(`{${C.dim}-fg}  ↳ ${esc(ti.name)}: ${esc(fp)}{/${C.dim}-fg}`);
          } else if (ti.question) {
            // AskUserQuestion: show question and options
            const q = ti.question;
            const header = q.header || "Question";
            parts.push(`{${C.dim}-fg}  ↳ ${esc(header)}{/${C.dim}-fg}`);
            const qText = truncateAtWord(q.text, maxWidth - 4);
            parts.push(`{${C.muted}-fg}    ${esc(qText)}{/${C.muted}-fg}`);
            for (let i = 0; i < q.options.length; i++) {
              const trunc = truncateAtWord(q.options[i].label, maxWidth - 8);
              parts.push(`{${C.peach}-fg}    ${i + 1}. ${esc(trunc)}{/${C.peach}-fg}`);
            }
          } else {
            // Other tools: just show name
            parts.push(`{${C.dim}-fg}  ↳ ${esc(ti.name)}{/${C.dim}-fg}`);
          }
        }
      } else {
        // Fallback: tool names only
        const names = msg.toolNames?.join(", ") || "unknown";
        parts.push(`{${C.dim}-fg}  ↳ ${esc(names)}{/${C.dim}-fg}`);
      }

      // Denied/errored tool result — one compact event marker, suppress the
      // (often long) denial content entirely.
      if (msg.toolError) {
        const name = msg.toolNames?.[0] || "tool";
        parts.push(`{${C.dim}-fg}  ⊘ ${esc(name)} denied{/${C.dim}-fg}`);
      } else if (msg.bashOutput) {
        // Show bash output if available (truncated)
        const outputLines = msg.bashOutput.trim().split("\n");
        const maxOutputLines = 4;
        const shown = outputLines.slice(0, maxOutputLines);
        for (const line of shown) {
          const truncated = truncateAtWord(line, maxWidth - 4);
          parts.push(`{${C.dim}-fg}    ${esc(truncated)}{/${C.dim}-fg}`);
        }
        if (outputLines.length > maxOutputLines) {
          parts.push(`{${C.dim}-fg}    … ${outputLines.length - maxOutputLines} more lines{/${C.dim}-fg}`);
        }
      }
      break;
    }

  }

  return parts.join("\n");
}

/** Build plain text for clipboard from messages */
export function buildPlainText(messages: PreviewMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`❯ ${msg.text}`);
        break;
      case "assistant":
        parts.push(msg.text);
        break;
      case "tool-use":
        if (msg.toolInputs) {
          for (const ti of msg.toolInputs) {
            if (ti.command) {
              parts.push(`↳ ${ti.name}\n  $ ${ti.command}`);
            } else if (ti.filePath) {
              parts.push(`↳ ${ti.name}: ${ti.filePath}`);
            } else if (ti.question) {
              parts.push(`↳ ${ti.question.header || "Question"}\n  ${ti.question.text}\n${ti.question.options.map((o, i) => `  ${i + 1}. ${o.label}`).join("\n")}`);
            } else {
              parts.push(`↳ ${ti.name}`);
            }
          }
        } else if (msg.toolNames) {
          parts.push(`↳ ${msg.toolNames.join(", ")}`);
        }
        if (msg.bashOutput) parts.push(msg.bashOutput);
        break;
    }
  }
  return parts.join("\n\n");
}

// -- Helpers for decision-first preview --

/** Map tool names to Claude Code's display titles */
function toolTitle(name: string): string {
  switch (name) {
    case "Read": return "Read file";
    case "Bash": return "Run bash command";
    case "Edit": return "Edit file";
    case "Write": return "Write new file";
    case "Glob": return "Search files";
    case "Grep": return "Search content";
    case "Agent": return "Launch agent";
    case "WebFetch": return "Fetch URL";
    case "WebSearch": return "Web search";
    default: return name;
  }
}

/** Render tool call details like Claude Code does */
function renderToolDetails(pending: PendingToolCall, maxWidth: number): string[] {
  const lines: string[] = [];
  const name = pending.name;

  if (name === "Bash") {
    if (pending.description) {
      lines.push(`  {${C.muted}-fg}${esc(pending.description)}{/${C.muted}-fg}`);
      lines.push("");
    }
    if (pending.command) {
      // Wrap long commands across multiple lines
      const cmdLines = wrapText(`$ ${pending.command}`, maxWidth - 4);
      for (const cl of cmdLines) {
        lines.push(`  {${C.peach}-fg}${esc(cl)}{/${C.peach}-fg}`);
      }
    }
  } else if (name === "Edit" && pending.oldString && pending.newString) {
    if (pending.filePath) {
      lines.push(`  {${C.muted}-fg}${esc(truncPath(pending.filePath, maxWidth - 4))}{/${C.muted}-fg}`);
      lines.push("");
    }
    lines.push(...renderInlineDiff(pending.oldString, pending.newString, maxWidth));
  } else if (name === "Write") {
    if (pending.filePath) {
      lines.push(`  {${C.muted}-fg}${esc(truncPath(pending.filePath, maxWidth - 4))}{/${C.muted}-fg}`);
      lines.push("");
    }
    if (pending.content) {
      const contentLines = pending.content.split("\n");
      const maxShow = 8;
      for (let i = 0; i < Math.min(contentLines.length, maxShow); i++) {
        const trunc = truncateAtWord(contentLines[i], maxWidth - 4);
        lines.push(`  {${C.dim}-fg}${esc(trunc)}{/${C.dim}-fg}`);
      }
      if (contentLines.length > maxShow) {
        lines.push(`  {${C.dim}-fg}… ${contentLines.length - maxShow} more lines{/${C.dim}-fg}`);
      }
    }
  } else if (name === "Read") {
    if (pending.filePath) {
      lines.push(`  {${C.muted}-fg}Read(${esc(truncPath(pending.filePath, maxWidth - 8))}){/${C.muted}-fg}`);
    }
  } else if (name === "Glob") {
    if (pending.pattern) {
      lines.push(`  {${C.muted}-fg}Glob(${esc(pending.pattern)}){/${C.muted}-fg}`);
    }
  } else if (name === "Grep") {
    const parts = [pending.pattern ? `"${pending.pattern}"` : ""];
    if (pending.filePath) parts.push(`in ${truncPath(pending.filePath, maxWidth - 20)}`);
    lines.push(`  {${C.muted}-fg}Grep(${esc(parts.filter(Boolean).join(" "))}){/${C.muted}-fg}`);
  } else {
    // Generic: show whatever details we have
    if (pending.filePath) {
      lines.push(`  {${C.muted}-fg}${esc(truncPath(pending.filePath, maxWidth - 4))}{/${C.muted}-fg}`);
    }
    if (pending.command) {
      const cmd = truncateAtWord(pending.command, maxWidth - 6);
      lines.push(`  {${C.peach}-fg}$ ${esc(cmd)}{/${C.peach}-fg}`);
    }
  }

  return lines;
}

/** Truncate a file path, keeping the end visible */
function truncPath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  return "…" + path.slice(-(maxLen - 1));
}

/** Truncate to maxLen on a word boundary, appending "…" (no mid-word cuts). */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return wrapText(text, Math.max(1, maxLen - 1))[0] + "…";
}

/** Wrap text into lines of maxLen, breaking at spaces when possible */
function wrapText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let breakAt = remaining.lastIndexOf(" ", maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining) lines.push(remaining);
  return lines;
}

/** Render inline diff from old/new strings: red - lines, mint + lines, capped at maxLines */
function renderInlineDiff(oldStr: string, newStr: string, maxWidth: number, maxLines = 12): string[] {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const diffLines: string[] = [];

  for (const line of oldLines) {
    const trunc = line.length > maxWidth - 4 ? line.slice(0, maxWidth - 5) + "…" : line;
    diffLines.push(`{${C.red}-fg}- ${esc(trunc)}{/${C.red}-fg}`);
  }
  for (const line of newLines) {
    const trunc = line.length > maxWidth - 4 ? line.slice(0, maxWidth - 5) + "…" : line;
    diffLines.push(`{${C.mint}-fg}+ ${esc(trunc)}{/${C.mint}-fg}`);
  }

  if (diffLines.length > maxLines) {
    const overflow = diffLines.length - maxLines;
    return [...diffLines.slice(0, maxLines), `{${C.dim}-fg}… ${overflow} more lines{/${C.dim}-fg}`];
  }
  return diffLines;
}

// -- Preview rendering --

/** Injectable transcript/pending sources — defaults hit the real files; tests
 *  pass stubs so the render logic can be exercised without disk or a tmux pane. */
export interface PreviewDeps {
  readTurns: (path: string) => Promise<TranscriptTurn[]>;
  getPending: (sessionId: string) => PendingToolCall | null;
}

const DEFAULT_DEPS: PreviewDeps = { readTurns: readTranscriptTurns, getPending: pendingToolCall };

export async function updatePreview(
  box: Widgets.BoxElement,
  session: Session | null,
  { archivedSessions, deps = DEFAULT_DEPS }: { scrollToBottom?: boolean; archivedSessions?: Session[]; deps?: PreviewDeps } = {},
): Promise<PendingToolCall | null> {
  if (session === null && archivedSessions) {
    // Archive summary: show list of archived sessions
    const lines: string[] = [
      `{${C.muted}-fg}  ${archivedSessions.length} archived session${archivedSessions.length === 1 ? "" : "s"}{/${C.muted}-fg}`,
      "",
    ];
    for (const s of archivedSessions) {
      const branch = s.branch || "no branch";
      const time = formatTimeAgo(s.modified);
      const summary = s.summary
        ? s.summary.replace(/\{/g, "{open}").replace(/\}/g, "{close}").replace(/\n/g, " ")
        : "";
      const truncSummary = truncateAtWord(summary, 60);
      lines.push(
        `  {${C.dim}-fg}${branch}{/${C.dim}-fg}  {${C.dim}-fg}${time}{/${C.dim}-fg}` +
        (truncSummary ? `  {${C.dim}-fg}${truncSummary}{/${C.dim}-fg}` : ""),
      );
    }
    lastPlainText = "";
    box.setContent(lines.join("\n"));
    return null;
  }

  if (session === null) {
    lastPlainText = "";
    box.setContent("");
    return null;
  }

  // Header: repo/branch · summary
  const boxWidth = typeof box.width === "number" ? box.width : 40;
  const contentWidth = Math.max(10, boxWidth - 4); // Account for padding + border
  const repoHeader = `${session.repo}/${session.branch}`;
  let header = `{${C.muted}-fg}  ${repoHeader}{/${C.muted}-fg}`;
  if (session.summary) {
    const escapedSummary = session.summary
      .replace(/\{/g, "{open}")
      .replace(/\}/g, "{close}")
      .replace(/\n/g, " ");
    const maxSummaryLen = Math.max(10, contentWidth - repoHeader.length - 5);
    const truncSummary = truncateAtWord(escapedSummary, maxSummaryLen);
    header += ` {${C.dim}-fg}·{/${C.dim}-fg} {${C.muted}-fg}${truncSummary}{/${C.muted}-fg}`;
  }

  // Try JSONL-based rendering
  const sessionPath = getSessionPath(session);
  let body = "";
  let pendingResult: PendingToolCall | null = null;

  if (sessionPath) {
    // Source the preview from the JSONL transcript via transcript.ts (correct
    // after /rewind; reflects resolved history). Keep the last few conversational
    // messages; scroll-to-bottom keeps the most recent visible.
    const turns = await deps.readTurns(sessionPath);
    const messages = transcriptToMessages(turns).slice(-PREVIEW_MSG_LIMIT);

    if (messages.length > 0) {
      // Decision-last layout for waiting sessions — mimic Claude Code's scrollback:
      // chronological history above, the live question/permission at the bottom.
      if (session.status === "waiting") {
        // Pending tool/question comes from the PreToolUse event (A3), not the
        // transcript. Pre-hook sessions (no event log) fall to the generic block.
        const pending = session.id ? deps.getPending(session.id) : null;
        pendingResult = pending;

        // Build decision block (goes at BOTTOM) — mirrors Claude Code's permission UI
        const dl: string[] = [];

        if (pending?.question) {
          // AskUserQuestion — show question with numbered options
          const q = pending.question;
          const count = pending.questions?.length ?? 1;
          // Multi-question prompts only render Q1 here — flag the rest so a desk user
          // sees the prompt is multi-part (1-9 opens the picker for all of them).
          const more = count > 1 ? `  {${C.dim}-fg}(${count} questions){/${C.dim}-fg}` : "";
          dl.push(`{bold}${esc(q.header || "Question")}{/bold}${more}`);
          dl.push("");
          dl.push(`  ${esc(truncateAtWord(q.question, contentWidth * 2))}`);
          dl.push("");
          for (let i = 0; i < q.options.length; i++) {
            const trunc = truncateAtWord(q.options[i].label, contentWidth - 8);
            const prefix = i === 0 ? "❯" : " ";
            dl.push(`{${C.peach}-fg}${prefix} ${i + 1}. ${esc(trunc)}{/${C.peach}-fg}`);
          }
        } else if (pending) {
          // Tool permission prompt — mimic Claude Code format
          const title = toolTitle(pending.name);
          dl.push(`{bold}${esc(title)}{/bold}`);
          dl.push("");

          // Call details
          dl.push(...renderToolDetails(pending, contentWidth));

          // "Do you want to proceed?" + numbered options
          dl.push("");
          dl.push("Do you want to proceed?");
          dl.push(`{${C.peach}-fg}❯ 1. Yes{/${C.peach}-fg}`);
          dl.push(`{${C.muted}-fg}  2. Yes, don't ask again for this session{/${C.muted}-fg}`);
          dl.push(`{${C.muted}-fg}  3. No{/${C.muted}-fg}`);
        } else {
          dl.push(`{bold}Waiting for input{/bold}`);
          dl.push("");
          dl.push("Do you want to proceed?");
          dl.push(`{${C.peach}-fg}❯ 1. Yes{/${C.peach}-fg}`);
          dl.push(`{${C.muted}-fg}  2. No{/${C.muted}-fg}`);
        }

        // History above (chronological, normal styling), decision block last.
        const historyParts: string[] = [];
        for (const msg of messages) {
          historyParts.push(renderMessage(msg, contentWidth));
        }

        body = historyParts.join("\n\n") + "\n\n" + dl.join("\n");
        lastPlainText = buildPlainText(messages);

        const content = `${header}\n\n${body}`;
        box.setContent(content);
        box.setScrollPerc(100); // Decision at bottom, like Claude's scrollback
        return pendingResult;
      }

      const renderedParts: string[] = [];

      for (const msg of messages) {
        renderedParts.push(renderMessage(msg, contentWidth));
      }

      // Add status indicator for running sessions
      if (session.status === "running") {
        renderedParts.push(`{${C.mint}-fg}⦿ Generating…{/${C.mint}-fg}`);
      }

      body = renderedParts.join("\n\n");
      lastPlainText = buildPlainText(messages);
    } else {
      body = `{${C.dim}-fg}No messages yet{/${C.dim}-fg}`;
      lastPlainText = "";
    }
  } else {
    // No session ID — show placeholder
    body = `{${C.dim}-fg}Session ID not resolved — will appear shortly{/${C.dim}-fg}`;
    lastPlainText = "";
  }

  const content = `${header}\n\n${body}`;
  box.setContent(content);
  // Always scroll to bottom — content is chronological, most recent at bottom.
  // Users can scroll up with u/d keys; next refresh re-snaps to bottom.
  box.setScrollPerc(100);
  return pendingResult;
}
