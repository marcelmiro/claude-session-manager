import type { Widgets } from "blessed";
import type { SearchEntry } from "../core/search";
import { C, statusColor, statusDot } from "./colors";
import { formatTimeAgo } from "../core/status";

/**
 * Render search results as a flat list in the blessed box.
 * Each row: [cursor] name · description   repo   status   age — with the right-side
 * columns aligned across rows (repo/age padded to the widest in view, status fixed).
 */
export function renderSearchResults(
  box: Widgets.BoxElement,
  results: SearchEntry[],
  selectedIndex: number,
): void {
  if (results.length === 0) {
    box.setContent(
      `\n\n\n{center}{${C.muted}-fg}No matching sessions{/${C.muted}-fg}{/center}` +
        `\n{center}{${C.dim}-fg}Esc clears the query{/${C.dim}-fg}{/center}`,
    );
    return;
  }

  const lines: string[] = [];
  const boxWidth = typeof box.width === "number" ? box.width : 60;
  const contentWidth = boxWidth - 3; // scrollbar + safety

  // Column widths shared by every row so the right side lines up.
  const repoW = Math.min(
    18,
    Math.max(...results.map((e) => (e.isDeletedWorktree ? 2 : 0) + e.repo.length)),
  );
  const timeW = Math.max(...results.map((e) => formatTimeAgo(e.modified).length));

  const esc = (s: string) => s.replace(/\{/g, "{open}").replace(/\}/g, "{close}");

  for (let i = 0; i < results.length; i++) {
    const entry = results[i];
    const isSelected = i === selectedIndex;

    // Status indicator
    let dot: string;
    let statusText: string;
    let sColor: string;

    if (entry.isActive && entry.activeStatus) {
      dot = statusDot(entry.activeStatus);
      sColor = statusColor(entry.activeStatus);
      statusText = (entry.activeStatus === "ready" ? "input" : entry.activeStatus).padEnd(8);
    } else {
      dot = "○"; // ○
      sColor = C.dim;
      statusText = "archived";
    }

    // Right-side columns: repo (worktree warning included), status, age.
    const repoStr = (entry.isDeletedWorktree ? "⚠ " : "") + entry.repo;
    const repoCol =
      repoStr.length > repoW ? repoStr.slice(0, repoW - 1) + "…" : repoStr.padEnd(repoW);
    const timeStr = formatTimeAgo(entry.modified).padStart(timeW);

    // Layout: cursor(2) | name · description | gap(>=2) | repo | dot+status(10) | age
    const rightWidth = repoW + 1 + 10 + 1 + timeW;
    const labelMax = Math.max(8, contentWidth - 2 - rightWidth - 2);

    // Description: when the query hit lives in conversation content or the first
    // prompt, the summary alone doesn't show WHY the row matched — the engine's
    // snippet does, so it takes the description slot.
    const desc =
      ((entry.matchField === "content" || entry.matchField === "firstPrompt") && entry.matchSnippet) ||
      entry.summary ||
      entry.firstPrompt ||
      "(no description)";

    // Name and description render in different colors, so truncate them as separate
    // plain-text parts (the name is kept whole while it fits; the description absorbs
    // the cut).
    const sep = " · ";
    let namePart = entry.name;
    let descPart = desc.replace(/\s+/g, " ").trim();
    if (namePart) {
      if (namePart.length + sep.length + 1 > labelMax) {
        if (namePart.length > labelMax) namePart = namePart.slice(0, labelMax - 1) + "…";
        descPart = "";
      } else {
        const room = labelMax - namePart.length - sep.length;
        if (descPart.length > room) descPart = descPart.slice(0, room - 1) + "…";
      }
    } else if (descPart.length > labelMax) {
      descPart = descPart.slice(0, labelMax - 1) + "…";
    }
    const plainLen = namePart.length + (namePart && descPart ? sep.length : 0) + descPart.length;
    const gap = " ".repeat(Math.max(2, contentWidth - 2 - plainLen - rightWidth));

    const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg} ` : "  ";
    const sepTag = namePart && descPart ? `{${C.dim}-fg}${sep}{/${C.dim}-fg}` : "";

    if (isSelected) {
      lines.push(
        `{${C.surface}-bg}` +
          cursor +
          (namePart ? `{bold}{${C.fg}-fg}${esc(namePart)}{/${C.fg}-fg}{/bold}` : "") +
          sepTag +
          (descPart ? `{${C.fg}-fg}${esc(descPart)}{/${C.fg}-fg}` : "") +
          gap +
          `{${C.dim}-fg}${repoCol}{/${C.dim}-fg} ` +
          `{${sColor}-fg}${dot} ${statusText}{/${sColor}-fg}` +
          ` {${C.muted}-fg}${timeStr}{/${C.muted}-fg}` +
          `{/${C.surface}-bg}`,
      );
    } else {
      lines.push(
        "  " +
          (namePart ? `{${C.fg}-fg}${esc(namePart)}{/${C.fg}-fg}` : "") +
          sepTag +
          (descPart ? `{${C.muted}-fg}${esc(descPart)}{/${C.muted}-fg}` : "") +
          gap +
          `{${C.dim}-fg}${repoCol}{/${C.dim}-fg} ` +
          `{${sColor}-fg}${dot} ${statusText}{/${sColor}-fg}` +
          ` {${C.dim}-fg}${timeStr}{/${C.dim}-fg}`,
      );
    }
  }

  box.setContent(lines.join("\n"));

  // Scroll to keep selected row visible
  if (selectedIndex >= 0) {
    const boxHeight = (box as any).height as number;
    const visibleHeight = typeof boxHeight === "number" ? boxHeight - 2 : 20;
    const scrollPos = (box as any).childBase || 0;

    if (selectedIndex < scrollPos) {
      box.scrollTo(selectedIndex);
    } else if (selectedIndex >= scrollPos + visibleHeight) {
      box.scrollTo(selectedIndex - visibleHeight + 1);
    }
  }
}
