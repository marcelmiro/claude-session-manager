import blessed from "blessed";
import { C } from "./colors";

export function createLayout() {
  const screen = blessed.screen({
    smartCSR: true,
    title: "csm",
    fullUnicode: true,
  });

  // Main container with border
  const container = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    border: { type: "line" },
    style: {
      border: { fg: C.dim },
    },
  });

  // Session list — top region, flexible
  const listBox = blessed.box({
    parent: container,
    top: 0,
    left: 1,
    right: 1,
    // Leave room for preview (30% + 1 border line) and status bar (1 line)
    height: "70%-2",
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: " " },
    tags: true,
    style: {
      fg: C.fg,
    },
  });

  // Preview pane — bottom portion
  const previewBox = blessed.box({
    parent: container,
    top: "70%-1",
    left: 0,
    right: 0,
    bottom: 2,
    border: { type: "line" },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      fg: C.fg,
      border: { fg: C.dim },
    },
    padding: { left: 1, right: 1 },
  });

  // Status bar — very bottom, 1 line
  const statusBar = blessed.box({
    parent: container,
    bottom: 0,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    style: {
      fg: C.dim,
    },
    padding: { left: 1 },
  });

  return { screen, listBox, previewBox, statusBar };
}
