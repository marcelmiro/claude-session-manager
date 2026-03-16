import type { Widgets } from "blessed";
import type { SearchEntry } from "../core/search";
import { C, statusColor, statusDot } from "./colors";
import { formatTimeAgo } from "../core/status";

/**
 * Render search results as a flat list in the blessed box.
 * Each row: [cursor] summary/firstPrompt (truncated)   repo   age
 */
export function renderSearchResults(
  box: Widgets.BoxElement,
  results: SearchEntry[],
  selectedIndex: number,
): void {
  if (results.length === 0) {
    box.setContent(
      `\n\n\n{center}{${C.muted}-fg}No matching sessions{/${C.muted}-fg}{/center}`,
    );
    return;
  }

  const lines: string[] = [];
  const boxWidth = typeof box.width === "number" ? box.width : 60;
  const contentWidth = boxWidth - 3; // scrollbar + safety

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
      dot = "\u25CB"; // ○
      sColor = C.dim;
      statusText = "archived";
    }

    // Worktree warning
    const wtWarning = entry.isDeletedWorktree ? "\u26A0 " : "";

    // Label: name · summary, or summary, or firstPrompt
    const description = entry.summary || entry.firstPrompt || "(no description)";
    const label = entry.name
      ? `${entry.name} \u00b7 ${description}`
      : description;
    const escapedLabel = label.replace(/\{/g, "{open}").replace(/\}/g, "{close}");

    // Right side: repo + age
    const timeStr = formatTimeAgo(entry.modified);
    const repoStr = wtWarning + entry.repo;

    // Layout: cursor(2) | label | gap(>=2) | repo(variable) | dot+status(10) | time(5)
    const rightWidth = repoStr.length + 1 + 10 + timeStr.length;
    const labelMax = Math.max(8, contentWidth - 2 - rightWidth - 2);
    const truncLabel = escapedLabel.length > labelMax
      ? escapedLabel.slice(0, labelMax - 1) + "\u2026"
      : escapedLabel;
    const gap = " ".repeat(Math.max(2, contentWidth - 2 - truncLabel.length - rightWidth));

    const cursor = isSelected ? `{${C.peach}-fg}\u25B8{/${C.peach}-fg} ` : "  ";

    if (isSelected) {
      lines.push(
        `{${C.surface}-bg}` +
          cursor +
          `{bold}{${C.fg}-fg}${truncLabel}{/${C.fg}-fg}{/bold}` +
          gap +
          `{${C.dim}-fg}${repoStr}{/${C.dim}-fg} ` +
          `{${sColor}-fg}${dot} ${statusText}{/${sColor}-fg}` +
          `{${C.muted}-fg}${timeStr}{/${C.muted}-fg}` +
          `{/${C.surface}-bg}`,
      );
    } else {
      lines.push(
        "  " +
          `{${C.muted}-fg}${truncLabel}{/${C.muted}-fg}` +
          gap +
          `{${C.dim}-fg}${repoStr}{/${C.dim}-fg} ` +
          `{${sColor}-fg}${dot} ${statusText}{/${sColor}-fg}` +
          `{${C.dim}-fg}${timeStr}{/${C.dim}-fg}`,
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
