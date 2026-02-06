import type { Widgets } from "blessed";
import type { RepoGroup, DisplayRow } from "../types";
import { C, statusColor, statusDot, contextColor } from "./colors";
import { formatTimeAgo } from "../core/status";

/**
 * Converts RepoGroup array into a flat list of DisplayRow items.
 * For each group: add a repo-header row, a separator row, then a session row for each session.
 * Adds a blank separator before each group except the first.
 */
export function buildDisplayRows(groups: RepoGroup[]): DisplayRow[] {
  const rows: DisplayRow[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];

    // Add blank separator before each group except the first
    if (i > 0) {
      rows.push({ type: "separator" });
    }

    // Repo header
    rows.push({ type: "repo-header", name: group.name, path: group.path });

    // Separator after header
    rows.push({ type: "separator" });

    // Session rows
    for (const session of group.sessions) {
      rows.push({ type: "session", session });
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
): void {
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (row.type === "repo-header") {
      lines.push(
        `{bold}{${C.peach}-fg}  ${row.name.toUpperCase()}{/${C.peach}-fg}{/bold}`,
      );
    } else if (row.type === "separator") {
      lines.push(
        `{${C.dim}-fg}  ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈{/${C.dim}-fg}`,
      );
    } else if (row.type === "session") {
      const session = row.session;
      const isSelected = i === selectedIndex;
      const isIdle = session.status === "idle";

      // Column values
      const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg} ` : "  ";
      const branch = session.branch.length > 20
        ? session.branch.slice(0, 20)
        : session.branch.padEnd(20);
      const dot = statusDot(session.status);
      const sColor = statusColor(session.status);
      const statusLabel = `${dot} ${session.status}`;
      const statusPadded = statusLabel.padEnd(12);
      const ctxStr = `${session.contextPercent}%`.padStart(6);
      const ctxClr = contextColor(session.contextPercent);
      const linesStr = `+${session.linesModified}`.padStart(8);
      const timeStr = formatTimeAgo(session.modified).padStart(5);

      if (isSelected) {
        // Selected row: full brightness with background
        lines.push(
          `{${C.surface}-bg}` +
            cursor +
            `{bold}{${C.fg}-fg}${branch}{/${C.fg}-fg}{/bold}` +
            `{${sColor}-fg}${statusPadded}{/${sColor}-fg}` +
            `{${ctxClr}-fg}${ctxStr}{/${ctxClr}-fg}` +
            `{${C.mint}-fg}${linesStr}{/${C.mint}-fg}` +
            `{${C.muted}-fg}${timeStr}{/${C.muted}-fg}` +
            `{/${C.surface}-bg}`,
        );
      } else if (isIdle) {
        // Idle unselected: entire row dimmed
        lines.push(
          `{${C.dim}-fg}` +
            "  " +
            branch +
            statusPadded +
            ctxStr +
            linesStr +
            timeStr +
            `{/${C.dim}-fg}`,
        );
      } else {
        // Normal unselected row
        lines.push(
          "  " +
            `{${C.muted}-fg}${branch}{/${C.muted}-fg}` +
            `{${sColor}-fg}${statusPadded}{/${sColor}-fg}` +
            `{${ctxClr}-fg}${ctxStr}{/${ctxClr}-fg}` +
            `{${C.mint}-fg}${linesStr}{/${C.mint}-fg}` +
            `{${C.muted}-fg}${timeStr}{/${C.muted}-fg}`,
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

    if (selectedIndex < scrollPos) {
      box.scrollTo(selectedIndex);
    } else if (selectedIndex >= scrollPos + visibleHeight) {
      box.scrollTo(selectedIndex - visibleHeight + 1);
    }
  }
}

/**
 * Returns indices of rows that are "session" type (not headers or separators).
 * Used for j/k navigation.
 */
export function getSelectableIndices(rows: DisplayRow[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type === "session") {
      indices.push(i);
    }
  }
  return indices;
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
