import { describe, expect, test } from "bun:test";
import { addDays, isDue, localMidnight, snoozeSpan, wakeAt, wakeBanner } from "./inbox-model";

// A fixed local moment: 2026-08-11 14:30 local time.
const NOW = new Date(2026, 7, 11, 14, 30).getTime();

describe("wakeAt", () => {
  test("hours are exact offsets", () => {
    expect(wakeAt(NOW, 16, "h")).toBe(NOW + 16 * 3_600_000);
  });

  test("days land on local midnight, not a 24h offset", () => {
    expect(wakeAt(NOW, 1, "d")).toBe(new Date(2026, 7, 12).getTime());
    expect(wakeAt(NOW, 3, "d")).toBe(new Date(2026, 7, 14).getTime());
  });

  test("a 1d snooze pressed just after local midnight wakes the NEXT midnight", () => {
    const justPastMidnight = new Date(2026, 7, 11, 0, 30).getTime();
    expect(wakeAt(justPastMidnight, 1, "d")).toBe(new Date(2026, 7, 12).getTime());
  });

  test("day math crosses month boundaries on the local calendar", () => {
    const aug31 = new Date(2026, 7, 31, 9, 0).getTime();
    expect(wakeAt(aug31, 1, "d")).toBe(new Date(2026, 8, 1).getTime());
  });
});

describe("addDays / localMidnight", () => {
  test("round-trip through YMD is local, not UTC", () => {
    expect(localMidnight(addDays(NOW, 0))).toBe(new Date(2026, 7, 11).getTime());
  });
});

describe("isDue", () => {
  test("due at or before now, not after", () => {
    expect(isDue(NOW, NOW)).toBe(true);
    expect(isDue(NOW - 1, NOW)).toBe(true);
    expect(isDue(NOW + 1, NOW)).toBe(false);
  });
});

describe("snoozeSpan", () => {
  test("tiers: days, hours, minutes — never 0m", () => {
    expect(snoozeSpan(NOW - 3 * 86_400_000, NOW)).toBe("3d");
    expect(snoozeSpan(NOW - 16 * 3_600_000, NOW)).toBe("16h");
    expect(snoozeSpan(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(snoozeSpan(NOW - 10_000, NOW)).toBe("1m");
  });
});

describe("wakeBanner", () => {
  test("embeds the span", () => {
    expect(wakeBanner(NOW - 2 * 86_400_000, NOW)).toBe(
      "-- snooze wake: snoozed 2d ago, due now - reopened automatically --",
    );
  });
});

// ── section derivation ─────────────────────────────────────────────────────

import { deriveSections, effectiveSince, isWoken, sectionOf, type InboxSession } from "./inbox-model";

const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;

function sess(over: Partial<InboxSession>): InboxSession {
  return { id: "x", repo: "csm", name: "n", reason: "turn-done", since: NOW - H, ...over };
}

describe("sectionOf", () => {
  test("archived <24h = done, >24h = off the sidebar", () => {
    expect(sectionOf(sess({ archivedAt: NOW - H }), NOW)).toBe("done");
    expect(sectionOf(sess({ archivedAt: NOW - D - 1 }), NOW)).toBeNull();
  });

  test("disposition parks; a due snooze reads as needs-you (woken)", () => {
    expect(sectionOf(sess({ disposition: { kind: "blocked", note: "" } }), NOW)).toBe("parked");
    expect(sectionOf(sess({ disposition: { kind: "snoozed", until: NOW + H } }), NOW)).toBe("parked");
    expect(sectionOf(sess({ disposition: { kind: "snoozed", until: NOW - M } }), NOW)).toBe("needs-you");
  });

  test("running until finishAt passes, then needs-you", () => {
    expect(sectionOf(sess({ running: { finishAt: NOW + M } }), NOW)).toBe("running");
    expect(sectionOf(sess({ running: { finishAt: NOW - M } }), NOW)).toBe("needs-you");
  });

  test("archived wins over disposition", () => {
    expect(sectionOf(sess({ archivedAt: NOW - M, disposition: { kind: "snoozed", until: NOW - M } }), NOW)).toBe("done");
  });
});

describe("effectiveSince", () => {
  test("ages from the derived flip, not the stale since", () => {
    expect(effectiveSince(sess({ running: { finishAt: NOW - 5 * M } }), NOW)).toBe(NOW - 5 * M);
    expect(effectiveSince(sess({ disposition: { kind: "snoozed", until: NOW - 2 * M } }), NOW)).toBe(NOW - 2 * M);
    expect(effectiveSince(sess({}), NOW)).toBe(NOW - H);
  });
});

describe("isWoken", () => {
  test("due snooze only, never archived", () => {
    expect(isWoken(sess({ disposition: { kind: "snoozed", until: NOW - 1 } }), NOW)).toBe(true);
    expect(isWoken(sess({ disposition: { kind: "snoozed", until: NOW + 1 } }), NOW)).toBe(false);
    expect(isWoken(sess({ archivedAt: NOW, disposition: { kind: "snoozed", until: NOW - 1 } }), NOW)).toBe(false);
  });
});

describe("deriveSections", () => {
  test("needs-you oldest-ignored first; running longest first (script anchor)", () => {
    const sections = deriveSections(
      [
        sess({ id: "young", since: NOW - M }),
        sess({ id: "old", since: NOW - D }),
        sess({ id: "run-new", since: NOW - 2 * M, running: { finishAt: NOW + H } }),
        sess({ id: "run-script", since: NOW - M, running: { finishAt: NOW + H }, script: true, scriptSince: NOW - H }),
      ],
      NOW,
    );
    expect(sections.needsYou.map((s) => s.id)).toEqual(["old", "young"]);
    expect(sections.running.map((s) => s.id)).toEqual(["run-script", "run-new"]);
  });

  test("parked: snoozed before blocked; wake soonest first; blocked least-blocked first", () => {
    const sections = deriveSections(
      [
        sess({ id: "blk-old", since: NOW - 3 * D, disposition: { kind: "blocked", note: "" } }),
        sess({ id: "blk-new", since: NOW - D, disposition: { kind: "blocked", note: "" } }),
        sess({ id: "snz-late", disposition: { kind: "snoozed", until: NOW + 3 * D } }),
        sess({ id: "snz-soon", disposition: { kind: "snoozed", until: NOW + H } }),
      ],
      NOW,
    );
    expect(sections.parked.map((s) => s.id)).toEqual(["snz-soon", "snz-late", "blk-new", "blk-old"]);
  });

  test("done newest first", () => {
    const sections = deriveSections(
      [sess({ id: "d1", archivedAt: NOW - 3 * H }), sess({ id: "d2", archivedAt: NOW - H })],
      NOW,
    );
    expect(sections.done.map((s) => s.id)).toEqual(["d2", "d1"]);
  });
});
