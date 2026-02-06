import { createLayout } from "./ui/layout";
import { renderStatusBar } from "./ui/status-bar";
import { buildDisplayRows, renderSessionList, moveSelection, getSelectableIndices } from "./ui/session-list";
import { updatePreview } from "./ui/preview-pane";
import { discoverSessions, groupSessions } from "./core/sessions";
import { writeSwitchTarget } from "./core/tmux";
import { C } from "./ui/colors";
import type { DisplayRow } from "./types";

const { screen, listBox, previewBox, statusBar } = createLayout();

let rows: DisplayRow[] = [];
let selectedIndex = -1;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function getSelectedSession() {
  if (selectedIndex < 0 || selectedIndex >= rows.length) return null;
  const row = rows[selectedIndex];
  return row.type === "session" ? row.session : null;
}

async function refresh() {
  const sessions = await discoverSessions();
  const groups = groupSessions(sessions);

  if (groups.length === 0) {
    // Empty state
    listBox.setContent(
      `\n\n\n{center}{${C.muted}-fg}No active sessions{/${C.muted}-fg}{/center}\n\n{center}{${C.dim}-fg}Start one with: claude{/${C.dim}-fg}{/center}`,
    );
    previewBox.setContent("");
    rows = [];
    selectedIndex = -1;
    screen.render();
    return;
  }

  rows = buildDisplayRows(groups);
  const selectable = getSelectableIndices(rows);

  // Preserve selection or pick first selectable
  if (selectedIndex < 0 || !selectable.includes(selectedIndex)) {
    selectedIndex = selectable.length > 0 ? selectable[0] : -1;
  }

  renderSessionList(listBox, rows, selectedIndex);
  await updatePreview(previewBox, getSelectedSession());
  screen.render();
}

async function handleSelect(direction: 1 | -1) {
  if (rows.length === 0) return;
  selectedIndex = moveSelection(rows, selectedIndex, direction);
  renderSessionList(listBox, rows, selectedIndex);
  await updatePreview(previewBox, getSelectedSession());
  screen.render();
}

function handleEnter() {
  const session = getSelectedSession();
  if (!session?.tmuxPane) return;

  const { paneId, sessionName, windowIndex } = session.tmuxPane;
  writeSwitchTarget(paneId, sessionName, windowIndex);
  cleanup();
  process.exit(0);
}

async function handleResume() {
  const session = getSelectedSession();
  if (!session || session.status !== "idle") return;

  try {
    await Bun.$`tmux new-window -n "claude" "claude --resume ${session.id}"`.quiet();
  } catch {
    // ignore
  }
  cleanup();
  process.exit(0);
}

function cleanup() {
  if (refreshTimer) clearInterval(refreshTimer);
  screen.destroy();
}

// Key bindings
screen.key(["j", "down"], () => handleSelect(1));
screen.key(["k", "up"], () => handleSelect(-1));
screen.key(["enter"], () => handleEnter());
screen.key(["r"], () => handleResume());
screen.key(["S-r"], () => refresh()); // Shift+R
screen.key(["q", "escape"], () => {
  cleanup();
  process.exit(0);
});

// Render status bar (static)
renderStatusBar(statusBar);

// Initial load + auto-refresh
refresh();
refreshTimer = setInterval(refresh, 3000);
