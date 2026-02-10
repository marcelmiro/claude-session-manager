import type { Widgets } from "blessed";
import type { RepoGroup, DisplayRow } from "../types";
import { C, statusColor, statusDot, contextColor } from "./colors";
import { formatTimeAgo } from "../core/status";

/**
 * Converts RepoGroup array into a flat list of DisplayRow items.
 * For each group: add a repo-header row, then session rows (with optional detail rows).
 * Adds a blank separator before each group except the first.
 */
export function buildDisplayRows(groups: RepoGroup[], showArchived = true): DisplayRow[] {
  const rows: DisplayRow[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    // Partition sessions into non-archived and archived
    const nonArchived = group.sessions.filter((s) => s.status !== "archived");
    const archived = group.sessions.filter((s) => s.status === "archived");

    // Skip groups with no visible sessions
    if (nonArchived.length === 0 && archived.length === 0) continue;

    // Add blank separator before each group except the first
    if (rows.length > 0) {
      rows.push({ type: "separator" });
    }

    // Repo header (compact — no separator after)
    rows.push({ type: "repo-header", name: group.name, path: group.path });

    // Non-archived session rows with optional detail rows
    for (const session of nonArchived) {
      rows.push({ type: "session", session });
      if (session.summary) {
        rows.push({ type: "session-detail", session });
      }
    }

    // Archived sessions: show individually or collapsed
    if (archived.length > 0) {
      if (showArchived) {
        for (const session of archived) {
          rows.push({ type: "session", session });
          if (session.summary) {
            rows.push({ type: "session-detail", session });
          }
        }
      } else {
        rows.push({
          type: "archive-collapsed",
          repoName: group.name,
          count: archived.length,
          sessions: archived,
        });
      }
    }
  }

  return rows;
}

/**
 * Renders the display rows into the blessed box using box.setContent().
 * Uses blessed tags for colors.
 */
export function renderSessionList(
  box: Widgets.BoxElement,
  rows: DisplayRow[],
  selectedIndex: number,
  attentionKeys?: Set<string>,
): void {
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.type === "repo-header") {
      lines.push(
        `{bold}{${C.peach}-fg}  ${row.name.toUpperCase()}{/${C.peach}-fg}{/bold}`,
      );
    } else if (row.type === "separator") {
      lines.push("");
    } else if (row.type === "session-detail") {
      const session = row.session;
      // Check if parent session row (i-1) is selected
      const parentSelected = (i - 1) === selectedIndex;
      const escaped = session.summary
        .replace(/\{/g, "{open}")
        .replace(/\}/g, "{close}");
      // 4ch indent to align under branch text
      const boxWidth = typeof box.width === "number" ? box.width : 60;

      // Prepend name in peach if available
      const nameTag = session.name
        ? `{${C.peach}-fg}[${session.name}]{/${C.peach}-fg} `
        : "";
      const nameLen = session.name ? session.name.length + 3 : 0; // [name] + space
      const maxLen = Math.max(10, boxWidth - 6 - nameLen);
      const truncated = escaped.length > maxLen ? escaped.slice(0, maxLen - 1) + "…" : escaped;

      if (parentSelected) {
        lines.push(
          `{${C.surface}-bg}    ${nameTag}{${C.muted}-fg}${truncated}{/${C.muted}-fg}{/${C.surface}-bg}`,
        );
      } else {
        lines.push(
          `    ${nameTag}{${C.dim}-fg}${truncated}{/${C.dim}-fg}`,
        );
      }
    } else if (row.type === "session") {
      const session = row.session;
      const isSelected = i === selectedIndex;
      const isDimmed = session.status === "idle" || session.status === "archived";

      // Check if this session needs attention (blinking dot)
      const sessionKey = session.tmuxPane?.paneId ?? session.id;
      const needsAttention = attentionKeys?.has(sessionKey) ?? false;

      // Column values
      const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg} ` : "  ";
      const branch = session.branch.length > 20
        ? "…" + session.branch.slice(-19)
        : session.branch.padEnd(20);
      const dot = statusDot(session.status);
      const sColor = statusColor(session.status);
      const dotStr = needsAttention ? `{blink}${dot}{/blink}` : dot;
      const displayLabel = session.status === "ready" ? "input" : session.status;
      const statusLabel = `${dotStr} ${displayLabel}`;
      const statusPadded = needsAttention
        ? `${dotStr} ${displayLabel.padEnd(10)}`
        : statusLabel.padEnd(12);
      const ctxStr = `${session.contextPercent}%`.padStart(6);
      const ctxClr = contextColor(session.contextPercent);
      const timeStr = formatTimeAgo(session.modified).padStart(5);

      if (isSelected) {
        // Selected row: full brightness with background
        lines.push(
          `{${C.surface}-bg}` +
            cursor +
            `{bold}{${C.fg}-fg}${branch}{/${C.fg}-fg}{/bold}` +
            ` ` +
            `{${sColor}-fg}${statusPadded}{/${sColor}-fg}` +
            `{${ctxClr}-fg}${ctxStr}{/${ctxClr}-fg}` +
            `{${C.muted}-fg}${timeStr}{/${C.muted}-fg}` +
            `{/${C.surface}-bg}`,
        );
      } else if (isDimmed) {
        // Idle unselected: entire row dimmed
        lines.push(
          `{${C.dim}-fg}` +
            "  " +
            branch +
            " " +
            statusPadded +
            ctxStr +
            timeStr +
            `{/${C.dim}-fg}`,
        );
      } else {
        // Normal unselected row
        lines.push(
          "  " +
            `{${C.muted}-fg}${branch}{/${C.muted}-fg}` +
            ` ` +
            `{${sColor}-fg}${statusPadded}{/${sColor}-fg}` +
            `{${ctxClr}-fg}${ctxStr}{/${ctxClr}-fg}` +
            `{${C.muted}-fg}${timeStr}{/${C.muted}-fg}`,
        );
      }
    } else if (row.type === "archive-collapsed") {
      const isSelected = i === selectedIndex;
      const label = `${row.count} archived`;
      if (isSelected) {
        lines.push(
          `{${C.surface}-bg}{${C.peach}-fg}▸{/${C.peach}-fg} {${C.muted}-fg}${label}{/${C.muted}-fg}{/${C.surface}-bg}`,
        );
      } else {
        lines.push(
          `  {${C.dim}-fg}${label}{/${C.dim}-fg}`,
        );
      }
    }
  }

  box.setContent(lines.join("\n"));

  // Scroll to keep the selected row visible within the box
  if (selectedIndex >= 0) {
    const boxHeight = (box as any).height as number;
    const visibleHeight = typeof boxHeight === "number" ? boxHeight - 2 : 20; // -2 for padding/border
    const scrollPos = (box as any).childBase || 0;

    // Also ensure the detail row below (if any) is visible
    let bottomRow = selectedIndex;
    if (selectedIndex + 1 < rows.length && rows[selectedIndex + 1].type === "session-detail") {
      bottomRow = selectedIndex + 1;
    }

    if (selectedIndex < scrollPos) {
      // Walk backwards through repo-header and separator rows to keep context visible
      let scrollTarget = selectedIndex;
      for (let r = selectedIndex - 1; r >= 0; r--) {
        const rt = rows[r].type;
        if (rt === "repo-header" || rt === "separator") {
          scrollTarget = r;
        } else {
          break;
        }
      }
      box.scrollTo(scrollTarget);
    } else if (bottomRow >= scrollPos + visibleHeight) {
      box.scrollTo(bottomRow - visibleHeight + 1);
    }
  }
}

/**
 * Returns indices of rows that are "session" type (not headers, separators, or details).
 * Used for j/k navigation.
 */
export function getSelectableIndices(rows: DisplayRow[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].type;
    if (t === "session" || t === "archive-collapsed") {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Moves to the first selectable row of the next/previous repo group.
 * Used for J/K (shift) navigation. Wraps around at boundaries.
 */
export function moveToGroup(
  rows: DisplayRow[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const selectable = getSelectableIndices(rows);
  if (selectable.length === 0) return currentIndex;

  // Find which repo-header each selectable row belongs to
  // by scanning backwards from each selectable index to find its group header
  function groupHeaderFor(rowIdx: number): number {
    for (let r = rowIdx; r >= 0; r--) {
      if (rows[r].type === "repo-header") return r;
    }
    return 0;
  }

  const currentGroup = groupHeaderFor(currentIndex);

  if (direction === 1) {
    // Find first selectable row in the next group
    const next = selectable.find((idx) => groupHeaderFor(idx) > currentGroup);
    if (next !== undefined) return next;
    // Wrap to first selectable
    return selectable[0];
  } else {
    // Find first selectable row in the previous group
    const prevGroups = selectable.filter((idx) => groupHeaderFor(idx) < currentGroup);
    if (prevGroups.length > 0) {
      // Jump to the first session of the previous group
      const prevGroupHeader = groupHeaderFor(prevGroups[prevGroups.length - 1]);
      const first = selectable.find((idx) => groupHeaderFor(idx) === prevGroupHeader);
      if (first !== undefined) return first;
    }
    // Wrap to last group's first selectable
    const lastGroupHeader = groupHeaderFor(selectable[selectable.length - 1]);
    const first = selectable.find((idx) => groupHeaderFor(idx) === lastGroupHeader);
    return first ?? selectable[selectable.length - 1];
  }
}

/**
 * Moves from currentIndex to the next selectable row in the given direction.
 * Skips repo-header and separator rows. Wraps around at boundaries.
 * Returns the new index.
 */
export function moveSelection(
  rows: DisplayRow[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const selectable = getSelectableIndices(rows);
  if (selectable.length === 0) return currentIndex;

  const currentPos = selectable.indexOf(currentIndex);

  if (currentPos === -1) {
    // Current index is not selectable; return first selectable
    return selectable[0];
  }

  let nextPos = currentPos + direction;

  // Wrap around
  if (nextPos < 0) {
    nextPos = selectable.length - 1;
  } else if (nextPos >= selectable.length) {
    nextPos = 0;
  }

  return selectable[nextPos];
}
