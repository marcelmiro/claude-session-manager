import { homedir } from "os";
import type { Widgets } from "blessed";
import type { Session } from "../types";

import { readPreviewMessages, readPendingToolCall, type PreviewMessage, type PendingToolCall } from "../core/jsonl-reader";
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

/** Resolve the JSONL path for a session */
export function getSessionPath(session: Session): string | null {
  if (!session.id) return null;
  const encodedPath = encodeProjectPath(session.repoPath);
  return `${homedir()}/.claude/projects/${encodedPath}/${session.id}.jsonl`;
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
      // User message — dimmed with ❯ prefix
      const text = msg.text.replace(/\n/g, " ").trim();
      const maxLen = maxWidth * 3; // Allow a few lines of user text
      const truncated = text.length > maxLen ? text.slice(0, maxLen - 1) + "…" : text;
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
            const cmd = ti.command.length > maxWidth - 6
              ? ti.command.slice(0, maxWidth - 7) + "…"
              : ti.command;
            parts.push(`{${C.dim}-fg}  ↳ ${esc(ti.name)}{/${C.dim}-fg}`);
            parts.push(`{${C.peach}-fg}    $ ${esc(cmd)}{/${C.peach}-fg}`);
          } else if (ti.filePath) {
            // Edit/Write: show file path
            const fp = ti.filePath.length > maxWidth - 6
              ? "…" + ti.filePath.slice(-(maxWidth - 7))
              : ti.filePath;
            parts.push(`{${C.dim}-fg}  ↳ ${esc(ti.name)}: ${esc(fp)}{/${C.dim}-fg}`);
          } else if (ti.question) {
            // AskUserQuestion: show question and options
            const q = ti.question;
            const header = q.header || "Question";
            parts.push(`{${C.dim}-fg}  ↳ ${esc(header)}{/${C.dim}-fg}`);
            const qText = q.text.length > maxWidth - 4
              ? q.text.slice(0, maxWidth - 5) + "…"
              : q.text;
            parts.push(`{${C.muted}-fg}    ${esc(qText)}{/${C.muted}-fg}`);
            for (let i = 0; i < q.options.length; i++) {
              const label = q.options[i].label;
              const trunc = label.length > maxWidth - 8
                ? label.slice(0, maxWidth - 9) + "…"
                : label;
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

      // Show bash output if available (truncated)
      if (msg.bashOutput) {
        const outputLines = msg.bashOutput.trim().split("\n");
        const maxOutputLines = 4;
        const shown = outputLines.slice(0, maxOutputLines);
        for (const line of shown) {
          const truncated = line.length > maxWidth - 4
            ? line.slice(0, maxWidth - 5) + "…"
            : line;
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
        const trunc = contentLines[i].length > maxWidth - 4
          ? contentLines[i].slice(0, maxWidth - 5) + "…"
          : contentLines[i];
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
      const cmd = pending.command.length > maxWidth - 6
        ? pending.command.slice(0, maxWidth - 7) + "…"
        : pending.command;
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

/** Replace all blessed color tags with dim color */
function dimContent(text: string): string {
  return text
    .replace(/\{#[0-9A-Fa-f]{6}-fg\}/g, `{${C.dim}-fg}`)
    .replace(/\{\/#[0-9A-Fa-f]{6}-fg\}/g, `{/${C.dim}-fg}`)
    .replace(/\{#[0-9A-Fa-f]{6}-bg\}/g, "")
    .replace(/\{\/#[0-9A-Fa-f]{6}-bg\}/g, "")
    .replace(/\{bold\}/g, "")
    .replace(/\{\/bold\}/g, "")
    .replace(/\{italic\}/g, "")
    .replace(/\{\/italic\}/g, "");
}

// -- Preview rendering --

export async function updatePreview(
  box: Widgets.BoxElement,
  session: Session | null,
  { archivedSessions }: { scrollToBottom?: boolean; archivedSessions?: Session[] } = {},
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
      const truncSummary = summary.length > 60 ? summary.slice(0, 59) + "…" : summary;
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
    const truncSummary = escapedSummary.length > maxSummaryLen ? escapedSummary.slice(0, maxSummaryLen - 1) + "…" : escapedSummary;
    header += ` {${C.dim}-fg}·{/${C.dim}-fg} {${C.muted}-fg}${truncSummary}{/${C.muted}-fg}`;
  }

  // Try JSONL-based rendering
  const sessionPath = getSessionPath(session);
  let body = "";
  let pendingResult: PendingToolCall | null = null;

  if (sessionPath) {
    const messages = await readPreviewMessages(sessionPath, 3);

    if (messages.length > 0) {
      // Decision-first layout for waiting sessions
      if (session.status === "waiting") {
        const pending = await readPendingToolCall(sessionPath);
        pendingResult = pending;

        // Build decision block (goes at TOP) — mirrors Claude Code's permission UI
        const dl: string[] = [];

        if (pending?.question) {
          // AskUserQuestion — show question with numbered options
          const q = pending.question;
          dl.push(`{bold}${esc(q.header || "Question")}{/bold}`);
          dl.push("");
          const qText = q.question.length > contentWidth * 2
            ? q.question.slice(0, contentWidth * 2 - 1) + "…"
            : q.question;
          dl.push(`  ${esc(qText)}`);
          dl.push("");
          for (let i = 0; i < q.options.length; i++) {
            const label = q.options[i].label;
            const trunc = label.length > contentWidth - 8
              ? label.slice(0, contentWidth - 9) + "…"
              : label;
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

        // History below, dimmed
        const historyParts: string[] = [];
        for (const msg of messages) {
          historyParts.push(dimContent(renderMessage(msg, contentWidth)));
        }

        body = dl.join("\n") + "\n\n" + historyParts.join("\n\n");
        lastPlainText = buildPlainText(messages);

        const content = `${header}\n\n${body}`;
        box.setContent(content);
        box.setScrollPerc(0); // Decision at top
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
