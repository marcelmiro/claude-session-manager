import { describe, expect, test } from "bun:test";
import { dueWakes } from "./inbox-wake";
import type { DispositionRow } from "./inbox-store";

const NOW = 1_000_000;

function snoozed(id: string, until: number, over: Partial<DispositionRow> = {}): [string, DispositionRow] {
  return [id, { sessionId: id, kind: "snoozed", until, note: null, createdAt: NOW - 5_000, autoResumed: false, ...over }];
}

describe("dueWakes", () => {
  test("due = snoozed, past until, unclaimed, not archived, no live pane", () => {
    const disp = new Map([
      snoozed("due", NOW - 1),
      snoozed("exactly-now", NOW),
      snoozed("future", NOW + 1),
      snoozed("claimed", NOW - 1, { autoResumed: true }),
      snoozed("archived", NOW - 1),
      snoozed("live", NOW - 1),
      ["blocked", { sessionId: "blocked", kind: "blocked" as const, until: null, note: "x", createdAt: 0, autoResumed: false }] as [string, DispositionRow],
    ]);
    const woken = dueWakes(disp, new Map([["archived", NOW - 100]]), new Set(["live"]), NOW);
    expect(woken.map((w) => w.sessionId).sort()).toEqual(["due", "exactly-now"]);
    expect(woken[0]!.snoozedAt).toBe(NOW - 5_000);
  });

  test("empty inputs wake nothing", () => {
    expect(dueWakes(new Map(), new Map(), new Set(), NOW)).toEqual([]);
  });
});
