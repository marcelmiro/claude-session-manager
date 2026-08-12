import { describe, expect, test } from "bun:test";
import { renderView, type ViewState } from "./rows";
import { plainLen } from "./ansi";
import type { InboxSession } from "../core/inbox-model";

const NOW = new Date(2026, 7, 11, 14, 30).getTime();
const M = 60_000;
const H = 3_600_000;

function sess(over: Partial<InboxSession>): InboxSession {
  return { id: "x", repo: "csm", name: "fix-auth", reason: "turn-done", since: NOW - H, ...over };
}

function vs(over: Partial<ViewState> = {}): ViewState {
  return {
    focused: false,
    selectedId: null,
    activePaneId: null,
    snoozeMenuFor: null,
    snoozeDigits: "",
    blockNoteFor: null,
    blockNote: "",
    helpVisible: false,
    flash: "",
    flashUntil: 0,
    scrollTop: 0,
    ...over,
  };
}

const DIMS = { width: 30, height: 20 };

const SAMPLE = [
  sess({ id: "n1", since: NOW - 2 * H }),
  sess({ id: "n2", reason: "question", since: NOW - 10 * M }),
  sess({ id: "r1", running: { finishAt: Number.MAX_SAFE_INTEGER }, since: NOW - 5 * M, real: { paneId: "%1", target: "main:1", status: "running" } }),
  sess({ id: "p1", disposition: { kind: "snoozed", until: NOW + 3 * H } }),
  sess({ id: "d1", archivedAt: NOW - H }),
];

describe("renderView", () => {
  test("exactly height rows, every row within width", () => {
    const view = renderView(SAMPLE, vs(), DIMS, NOW);
    expect(view.rows.length).toBe(DIMS.height);
    for (const row of view.rows) {
      expect(plainLen(row)).toBeLessThanOrEqual(DIMS.width);
    }
  });

  test("sections and rowAtLine cover both lines of a two-line row", () => {
    const view = renderView(SAMPLE, vs(), DIMS, NOW);
    expect(view.visible.map((v) => v.section)).toEqual([
      "needs-you",
      "needs-you",
      "running",
      "parked",
      "done",
    ]);
    // two-line rows map both content lines to the id
    const n1Lines = view.rowAtLine.filter((id) => id === "n1").length;
    expect(n1Lines).toBe(2);
    const p1Lines = view.rowAtLine.filter((id) => id === "p1").length;
    expect(p1Lines).toBe(1); // parked is one-line
  });

  test("unfocused = glance surface: no selection bg, empty hint row", () => {
    const view = renderView(SAMPLE, vs({ selectedId: "n1" }), DIMS, NOW);
    expect(view.rows.join("")).not.toContain("\x1b[48;2;51;51;51m");
    expect(view.rows[view.rows.length - 1]).toBe("");
  });

  test("focused: selection bg present, section hints in the bottom row", () => {
    const view = renderView(SAMPLE, vs({ focused: true, selectedId: "n1" }), DIMS, NOW);
    expect(view.rows.join("")).toContain("\x1b[48;2;51;51;51m");
    expect(view.rows[view.rows.length - 1]).toContain("s b e f");
  });

  test("snooze menu and block note chrome take the hint row", () => {
    const menu = renderView(SAMPLE, vs({ focused: true, selectedId: "n1", snoozeMenuFor: "n1", snoozeDigits: "16" }), DIMS, NOW);
    expect(menu.rows[menu.rows.length - 1]).toContain("snooze:");
    expect(menu.rows[menu.rows.length - 1]).toContain("16");
    const note = renderView(SAMPLE, vs({ focused: true, selectedId: "n1", blockNoteFor: "n1", blockNote: "stripe" }), DIMS, NOW);
    expect(note.rows[note.rows.length - 1]).toContain("stripe");
  });

  test("selected parked row gets a detail line with the exact wake", () => {
    const view = renderView(SAMPLE, vs({ focused: true, selectedId: "p1" }), DIMS, NOW);
    expect(view.rows[view.rows.length - 2]).toContain("until 17:30");
  });

  test("help overlay replaces content while focused", () => {
    const view = renderView(SAMPLE, vs({ focused: true, helpVisible: true }), DIMS, NOW);
    expect(view.rows.join("")).toContain("navigate");
    expect(view.rows[view.rows.length - 1]).toContain("close");
    expect(view.visible).toEqual([]);
  });

  test("narrow pane shows counts only", () => {
    const view = renderView(SAMPLE, vs(), { width: 12, height: 6 }, NOW);
    expect(view.rows.join("")).toContain("●2");
    expect(view.rows.join("")).toContain("⦿1");
    expect(view.rows.join("")).toContain("⏸1");
  });

  test("empty inbox shows inbox zero", () => {
    const view = renderView([], vs(), DIMS, NOW);
    expect(view.rows.join("")).toContain("inbox zero ✓");
  });

  test("focused selection below the fold scrolls into view", () => {
    const many = Array.from({ length: 20 }, (_, i) => sess({ id: `n${i}`, since: NOW - i * M }));
    const view = renderView(many, vs({ focused: true, selectedId: "n0" }), { width: 30, height: 10 }, NOW);
    // n0 is the YOUNGEST (needs-you sorts oldest first → last row); it must be visible
    expect(view.scrollTop).toBeGreaterThan(0);
    const contentRows = view.rows.slice(0, 9);
    expect(contentRows.join("")).toContain("\x1b[48;2;51;51;51m");
  });

  test("pin bar marks the window's active pane session", () => {
    const view = renderView(SAMPLE, vs({ activePaneId: "%1" }), DIMS, NOW);
    expect(view.rows.join("")).toContain("▎");
  });
});

test("prompt-sitters render under NEEDS YOU", () => {
  const view = renderView(
    [...SAMPLE, sess({ id: "o1", name: "idle-one" })],
    vs(),
    { width: 30, height: 24 },
    NOW,
  );
  expect(view.rows.join("")).toContain("idle-one");
  expect(view.visible.find((v) => v.id === "o1")?.section).toBe("needs-you");
});
