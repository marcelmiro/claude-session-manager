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
