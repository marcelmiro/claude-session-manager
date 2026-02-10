import { homedir } from "os";
import type { Widgets } from "blessed";
import type { Session } from "../types";

import { capturePane } from "../core/tmux";
import { getLastAssistantMessage } from "../core/sessions";
import { formatTimeAgo } from "../core/status";
import { C } from "./colors";

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

// -- ANSI → blessed color conversion --

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

/** Strip non-SGR ANSI sequences (cursor movement, clearing, OSC, etc.) while preserving SGR (\x1b[...m) */
function stripNonSgrAnsi(text: string): string {
  return text
    // Strip all CSI sequences EXCEPT SGR (final byte 'm')
    .replace(/\x1b\[([0-9;?]*)([\x40-\x7e])/g, (match, _params, final) =>
      final === "m" ? match : "",
    )
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")      // OSC
    .replace(/\x1b[()][0-9A-Za-z]/g, "")                     // Charset
    .replace(/\x1b(?!\[)[\x20-\x2f]*[\x30-\x7e]/g, "")      // Other non-CSI escapes ((?!\[) avoids CSI)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, ""); // Control chars (keep \x1b for SGR)
}

/**
 * Process a single SGR parameter sequence, emit blessed close/open tags,
 * and mutate `state` to reflect the new terminal style.
 */
function processSgr(params: string, state: TermStyle): string {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  let out = "";
  let i = 0;

  while (i < codes.length) {
    const c = codes[i];

    if (c === 0) {
      // Reset all
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
      // Extended color: 38;2;R;G;B (24-bit) or 38;5;N (256-color)
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

/**
 * Convert a line of text containing ANSI SGR codes into blessed markup.
 * `state` is mutated to carry over the style to the next line.
 * Each line is self-contained (tags are opened at start and closed at end)
 * so lines can be freely sliced for bottom-alignment.
 */
function convertLine(line: string, state: TermStyle): string {
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  let result = openTags(state);

  for (const part of parts) {
    const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!sgr) {
      // Plain text — escape braces so blessed doesn't interpret them
      result += part.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
      continue;
    }
    // processSgr handles closing old tags and opening new ones
    result += processSgr(sgr[1], state);
  }

  result += closeTags(state);
  return result;
}

/**
 * Convert ANSI-colored terminal output into blessed tag markup.
 * Each output line is self-contained so slicing for bottom-alignment is safe.
 */
export function ansiToBlessedMarkup(text: string): string {
  const cleaned = stripNonSgrAnsi(text);
  const lines = cleaned.split("\n");
  const state: TermStyle = { fg: null, bg: null, bold: false, italic: false };
  return lines.map((line) => convertLine(line, state)).join("\n");
}

// -- Claude Code UI chrome stripping --

/** Strip all ANSI escape sequences (including SGR) for pattern matching */
function stripAllAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[\x40-\x7e]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[\x20-\x2f]*[\x30-\x7e]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/**
 * Strip Claude Code UI chrome (input box, status line) from captured pane output.
 * Finds the ❯ prompt or status line and removes everything from the separator
 * border above it to the end, leaving only actual content.
 */
function stripClaudeChrome(text: string): string {
  const lines = text.split("\n");

  // Find the ❯ prompt line, scanning from bottom
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/❯/.test(stripAllAnsi(lines[i]))) {
      promptIdx = i;
      break;
    }
  }

  let cutIdx = lines.length;

  if (promptIdx !== -1) {
    // Scan upward from prompt past separators and blank lines to find top of chrome
    cutIdx = promptIdx;
    for (let i = promptIdx - 1; i >= 0; i--) {
      const clean = stripAllAnsi(lines[i]).trim();
      if (clean === "" || /^─+$/.test(clean)) {
        cutIdx = i;
        continue;
      }
      break;
    }
  } else {
    // No prompt found (e.g. running state) — look for status line (context %)
    let statusIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const clean = stripAllAnsi(lines[i]);
      if (/\d+\.?\d*k?\/\d+\.?\d*k?\s*\(\d+%\)/.test(clean)) {
        statusIdx = i;
        break;
      }
    }

    if (statusIdx !== -1) {
      cutIdx = statusIdx;
      for (let i = statusIdx - 1; i >= 0; i--) {
        const clean = stripAllAnsi(lines[i]).trim();
        if (clean === "" || /^─+$/.test(clean)) {
          cutIdx = i;
          continue;
        }
        break;
      }
    }
  }

  return lines.slice(0, cutIdx).join("\n");
}

// -- Preview rendering --

/** Trim blank lines from both ends and return only the last N lines */
function bottomAlignContent(text: string, availableLines: number): string {
  const lines = text.split("\n");

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }

  const visible = lines.slice(-availableLines);
  const padding = Math.max(0, availableLines - visible.length);
  return "\n".repeat(padding) + visible.join("\n");
}

export async function updatePreview(
  box: Widgets.BoxElement,
  session: Session | null,
  { scrollToBottom = false, archivedSessions }: { scrollToBottom?: boolean; archivedSessions?: Session[] } = {},
): Promise<void> {
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
    box.setContent(lines.join("\n"));
    return;
  }

  if (session === null) {
    box.setContent("");
    return;
  }

  // Header line 1: repo/branch · summary
  const boxWidth = typeof box.width === "number" ? box.width : 40;
  const repoHeader = `${session.repo}/${session.branch}`;
  let header = `{${C.muted}-fg}  ${repoHeader}{/${C.muted}-fg}`;
  if (session.summary) {
    const escapedSummary = session.summary
      .replace(/\{/g, "{open}")
      .replace(/\}/g, "{close}")
      .replace(/\n/g, " ");
    const maxSummaryLen = Math.max(10, boxWidth - repoHeader.length - 5);
    const truncSummary = escapedSummary.length > maxSummaryLen ? escapedSummary.slice(0, maxSummaryLen - 1) + "…" : escapedSummary;
    header += ` {${C.dim}-fg}·{/${C.dim}-fg} {${C.muted}-fg}${truncSummary}{/${C.muted}-fg}`;
  }

  let body = "";

  const boxHeight = typeof box.height === "number" ? box.height : 15;
  const availableLines = Math.max(1, boxHeight - 3);

  if (session.tmuxPane) {
    // Live session — reuse cached capture from status detection, or capture fresh
    const captured = session.lastCapture || await capturePane(session.tmuxPane.paneId, { escapes: true });
    // Strip Claude Code UI chrome (input box, status line) before conversion
    const stripped = stripClaudeChrome(captured);
    const trimmed = stripped.replace(/\n\s*$/g, "");
    const markup = ansiToBlessedMarkup(trimmed);
    body = bottomAlignContent(markup, availableLines);
  } else {
    // Idle session — show last assistant message
    const encodedPath = encodeProjectPath(session.repoPath);
    const sessionPath = `${homedir()}/.claude/projects/${encodedPath}/${session.id}.jsonl`;
    const lastMessage = await getLastAssistantMessage(sessionPath);

    if (lastMessage) {
      const escaped = lastMessage.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
      body = `{#A0A0A0-fg}{italic}${escaped}{/italic}{/#A0A0A0-fg}`;
    } else {
      body = `{#505050-fg}No recent output{/#505050-fg}`;
    }
  }

  const content = `${header}\n${body}`;
  box.setContent(content);
  if (scrollToBottom) {
    box.setScrollPerc(100);
  }
}
