import blessed from "blessed";
import { C } from "./colors";

// Blessed 0.1.81 falls back to an 8-color capability table for
// `tmux-256color`, despite the terminfo entry advertising 256 colors. Its
// renderer then crushes the Vesper palette down to ANSI black/red/white.
// Blessed itself only renders up to 256 colors, so use its complete, bundled
// xterm table while tmux continues to expose `tmux-256color` to child apps.
export const BLESSED_TERMINAL = "xterm-256color";

export function createLayout() {
  const screen = blessed.screen({
    terminal: BLESSED_TERMINAL,
    smartCSR: true,
    title: "c0",
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
      fg: C.fg,
      bg: C.bg,
      border: { fg: C.dim, bg: C.bg },
    },
  });

  // Session list — left region (70%)
  const listBox = blessed.box({
    parent: container,
    top: 0,
    left: 1,
    width: "50%-2",
    bottom: 1,
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: " " },
    tags: true,
    style: {
      fg: C.fg,
      bg: C.bg,
    },
  });

  // Preview pane — right sidebar (30%)
  const previewBox = blessed.box({
    parent: container,
    top: 0,
    left: "50%-1",
    right: 0,
    bottom: 1,
    border: { type: "line" },
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    style: {
      fg: C.fg,
      bg: C.bg,
      border: { fg: C.dim, bg: C.bg },
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
      fg: C.muted,
      bg: C.bg,
    },
    padding: { left: 1 },
  });

  return { screen, listBox, previewBox, statusBar };
}
