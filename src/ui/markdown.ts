/**
 * Markdown → blessed tag renderer.
 * Converts raw markdown text to blessed markup at a given target width.
 * Handles: paragraphs, headers, bold/italic, inline code, fenced code blocks,
 * pipe tables, bullet/numbered lists.
 */

import { C } from "./colors";

/** Escape blessed tag characters in text */
function esc(text: string): string {
  return text.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
}

/** Measure visible width of a string that may contain blessed tags */
function visibleLength(text: string): number {
  return text.replace(/\{[^}]*\}/g, "").length;
}

/**
 * Word-wrap a string that may contain blessed tags to maxWidth.
 * Measures visible width (excluding tags) for line-break decisions,
 * but preserves tags in the output.
 */
function wordWrap(text: string, maxWidth: number): string[] {
  if (maxWidth < 10) maxWidth = 10;

  // Split into segments of (blessed tags) and (visible text)
  const segments = text.split(/(\{[^}]*\})/);
  const lines: string[] = [];
  let currentLine = "";
  let currentWidth = 0;

  for (const segment of segments) {
    // Blessed tag — append without counting width
    if (segment.startsWith("{") && segment.endsWith("}")) {
      currentLine += segment;
      continue;
    }

    // Visible text — split into words and wrap
    const words = segment.split(/(\s+)/);
    for (const word of words) {
      if (word.length === 0) continue;

      if (currentWidth + word.length > maxWidth && currentLine.length > 0 && word.trim()) {
        lines.push(currentLine.trimEnd());
        currentLine = word.trimStart();
        currentWidth = currentLine.length;
      } else {
        currentLine += word;
        currentWidth += word.length;
      }

      // Force-break words longer than maxWidth
      while (currentWidth > maxWidth) {
        // Find a break point in the visible text of currentLine
        let visCount = 0;
        let breakIdx = 0;
        for (let c = 0; c < currentLine.length; c++) {
          if (currentLine[c] === "{") {
            // Skip blessed tag
            const end = currentLine.indexOf("}", c);
            if (end !== -1) { c = end; continue; }
          }
          visCount++;
          if (visCount >= maxWidth) {
            breakIdx = c + 1;
            break;
          }
        }
        if (breakIdx > 0 && breakIdx < currentLine.length) {
          lines.push(currentLine.slice(0, breakIdx));
          currentLine = currentLine.slice(breakIdx);
          currentWidth = visibleLength(currentLine);
        } else {
          break; // Can't break further
        }
      }
    }
  }

  if (currentLine.trim()) lines.push(currentLine.trimEnd());
  return lines.length > 0 ? lines : [""];
}

// Sentinels for bold/italic markers (Unicode private use area, won't appear in normal text)
const S_BOLD_O = "\uE000";
const S_BOLD_C = "\uE001";
const S_ITAL_O = "\uE002";
const S_ITAL_C = "\uE003";

/** Replace sentinel markers with blessed tags and escape remaining text */
function finalizeSentinels(text: string): string {
  let result = esc(text);
  result = result.replace(/\uE000/g, "{bold}");
  result = result.replace(/\uE001/g, "{/bold}");
  result = result.replace(/\uE002/g, "{italic}");
  result = result.replace(/\uE003/g, "{/italic}");
  return result;
}

/**
 * Apply inline markdown formatting (bold, italic, inline code).
 * Returns blessed-tagged text. Input should be raw markdown (not yet escaped).
 * Bold/italic are resolved first (can span across code), then code spans are extracted.
 */
function inlineFormat(text: string): string {
  // Phase 0: Collapse markdown links to their display text — the URL is noise in a
  // non-clickable pane and force-wraps mid-string. Images ![alt](url) collapse to alt.
  let marked = text.replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, "$1");

  // Phase 1: Mark bold/italic with sentinels on raw text (handles spans crossing code)
  marked = marked.replace(/\*{3}(.+?)\*{3}/g, `${S_BOLD_O}${S_ITAL_O}$1${S_ITAL_C}${S_BOLD_C}`);
  marked = marked.replace(/\*{2}(.+?)\*{2}/g, `${S_BOLD_O}$1${S_BOLD_C}`);
  marked = marked.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, `${S_ITAL_O}$1${S_ITAL_C}`);

  // Phase 2: Extract code spans, escape non-code, apply code styling
  const parts: string[] = [];
  let remaining = marked;

  while (remaining.length > 0) {
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (!codeMatch) {
      parts.push(finalizeSentinels(remaining));
      break;
    }

    const idx = codeMatch.index!;
    if (idx > 0) {
      parts.push(finalizeSentinels(remaining.slice(0, idx)));
    }
    // Code: strip sentinels, escape, apply peach color
    const codeText = codeMatch[1].replace(/[\uE000-\uE003]/g, "");
    parts.push(`{${C.peach}-fg}${esc(codeText)}{/${C.peach}-fg}`);
    remaining = remaining.slice(idx + codeMatch[0].length);
  }

  return parts.join("");
}

/** Parse a markdown pipe table and re-render to fit target width */
function renderTable(lines: string[], maxWidth: number): string[] {
  // Parse rows into cells
  const rows: string[][] = [];
  let alignRow = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.every((c) => /^:?-+:?$/.test(c))) {
      alignRow = i;
      continue;
    }
    rows.push(cells);
  }

  if (rows.length === 0) return lines.map((l) => esc(l));

  const colCount = Math.max(...rows.map((r) => r.length));

  for (const row of rows) {
    while (row.length < colCount) row.push("");
  }

  const colWidths: number[] = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      colWidths[c] = Math.max(colWidths[c], row[c].length);
    }
  }

  // Fit to available width
  const overhead = colCount + 1 + colCount * 2;
  const available = maxWidth - overhead;

  if (available > 0) {
    const totalNatural = colWidths.reduce((s, w) => s + w, 0);
    if (totalNatural > available) {
      const scale = available / totalNatural;
      for (let c = 0; c < colCount; c++) {
        colWidths[c] = Math.max(3, Math.floor(colWidths[c] * scale));
      }
    }
  }

  // Render — all table chrome uses dim color
  const dim = `{${C.dim}-fg}`;
  const dimEnd = `{/${C.dim}-fg}`;
  const output: string[] = [];

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].map((cell, c) => {
      const w = colWidths[c];
      const truncated = cell.length > w ? cell.slice(0, w - 1) + "…" : cell;
      return esc(truncated.padEnd(w));
    });
    output.push(`${dim}│${dimEnd} ${cells.join(` ${dim}│${dimEnd} `)} ${dim}│${dimEnd}`);

    if (r === 0 && alignRow !== -1) {
      const sep = colWidths.map((w) => "─".repeat(w + 2)).join("┼");
      output.push(`${dim}├${sep}┤${dimEnd}`);
    }
  }

  return output;
}

/** Render a fenced code block — indent and truncate lines */
function renderCodeBlock(lines: string[], maxWidth: number, _lang: string): string[] {
  const output: string[] = [];
  const codeWidth = maxWidth - 4;
  const indent = "  ";

  for (const line of lines) {
    const truncated =
      line.length > codeWidth ? esc(line.slice(0, codeWidth - 1)) + "…" : esc(line);
    output.push(`{${C.dim}-fg}${indent}${truncated}{/${C.dim}-fg}`);
  }

  return output;
}

/**
 * Convert markdown text to blessed tag markup, word-wrapped to maxWidth.
 * Returns the rendered string.
 */
export function markdownToBlessed(markdown: string, maxWidth: number): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Fenced code block
    const fenceMatch = trimmed.match(/^(`{3,})([\w]*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        if (lines[i].trimEnd().startsWith(fence)) {
          i++;
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      output.push(...renderCodeBlock(codeLines, maxWidth, lang));
      continue;
    }

    // Pipe table — collect consecutive lines starting with |
    if (trimmed.startsWith("|") && trimmed.includes("|", 1)) {
      const tableLines: string[] = [trimmed];
      i++;
      while (i < lines.length) {
        const tl = lines[i].trimEnd();
        if (tl.startsWith("|") || (tl.includes("|") && /^[\s|:\-]/.test(tl))) {
          tableLines.push(tl);
          i++;
        } else {
          break;
        }
      }
      if (tableLines.length >= 2) {
        output.push(...renderTable(tableLines, maxWidth));
      } else {
        output.push(...wordWrap(inlineFormat(trimmed), maxWidth));
      }
      continue;
    }

    // Blank line
    if (trimmed === "") {
      output.push("");
      i++;
      continue;
    }

    // ATX headers: # Header
    const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headerMatch) {
      const text = headerMatch[2].replace(/\s*#+\s*$/, "");
      const formatted = `{bold}{${C.fg}-fg}${inlineFormat(text)}{/${C.fg}-fg}{/bold}`;
      output.push(...wordWrap(formatted, maxWidth));
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) {
      output.push(`{${C.dim}-fg}${"─".repeat(Math.min(maxWidth, 40))}{/${C.dim}-fg}`);
      i++;
      continue;
    }

    // Blockquote: > text — dim left bar + muted text
    const quoteMatch = trimmed.match(/^>\s?(.*)/);
    if (quoteMatch) {
      const wrapped = wordWrap(inlineFormat(quoteMatch[1]), maxWidth - 2);
      for (const w of wrapped) {
        output.push(`{${C.dim}-fg}▎ {/${C.dim}-fg}{${C.muted}-fg}${w}{/${C.muted}-fg}`);
      }
      i++;
      continue;
    }

    // Bullet list item: - item, * item, + item
    const bulletMatch = trimmed.match(/^(\s*)([-*+])\s+(.*)/);
    if (bulletMatch) {
      const indent = Math.min(bulletMatch[1].length, 8);
      const text = bulletMatch[3];
      const prefix = " ".repeat(indent) + "• ";
      const contentWidth = maxWidth - prefix.length;
      const formatted = inlineFormat(text);
      const wrapped = wordWrap(formatted, contentWidth);
      output.push(`{${C.dim}-fg}${prefix}{/${C.dim}-fg}${wrapped[0]}`);
      for (let w = 1; w < wrapped.length; w++) {
        output.push(" ".repeat(prefix.length) + wrapped[w]);
      }
      i++;
      continue;
    }

    // Numbered list item: 1. item
    const numMatch = trimmed.match(/^(\s*)(\d+)[.)]\s+(.*)/);
    if (numMatch) {
      const indent = Math.min(numMatch[1].length, 8);
      const num = numMatch[2];
      const text = numMatch[3];
      const prefix = " ".repeat(indent) + `${num}. `;
      const contentWidth = maxWidth - prefix.length;
      const formatted = inlineFormat(text);
      const wrapped = wordWrap(formatted, contentWidth);
      output.push(`{${C.dim}-fg}${prefix}{/${C.dim}-fg}${wrapped[0]}`);
      for (let w = 1; w < wrapped.length; w++) {
        output.push(" ".repeat(prefix.length) + wrapped[w]);
      }
      i++;
      continue;
    }

    // Regular paragraph text — inline format first, then tag-aware word-wrap
    const formatted = inlineFormat(trimmed);
    output.push(...wordWrap(formatted, maxWidth));
    i++;
  }

  return output.join("\n");
}
