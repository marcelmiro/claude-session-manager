import { test, expect } from "bun:test";
import { formatTimeAgo } from "./time-ago.js";

const NOW = Date.UTC(2026, 6, 20, 12, 0, 0);
const ago = (sec: number, opts?: { verbose?: boolean }) =>
  formatTimeAgo(new Date(NOW - sec * 1000), { now: NOW, ...opts });

test("sub-minute reads as now", () => {
  expect(ago(0)).toBe("now");
  expect(ago(29)).toBe("now");
  expect(ago(31)).toBe("1m");
});

test("rounds to the nearest unit instead of truncating", () => {
  // The old formatter floored: 1h59m rendered as "1h", a 59-minute under-report.
  expect(ago(119 * 60)).toBe("2h");
  expect(ago(90 * 60)).toBe("2h"); // 1.5h → nearest is 2h
  expect(ago(80 * 60)).toBe("1h");
});

test("rounding up carries into the next tier", () => {
  expect(ago(59.6 * 60)).toBe("1h"); // not "60m"
  expect(ago(23.9 * 3600)).toBe("1d"); // not "24h"
  expect(ago(6.9 * 86400)).toBe("1w"); // not "7d"
});

test("compact form stays within the TUI's 5-column budget", () => {
  for (const sec of [0, 59, 3599, 86399, 6 * 86400, 20 * 86400, 200 * 86400]) {
    expect(ago(sec).length).toBeLessThanOrEqual(5);
  }
});

test("verbose adds the remainder unit at hour and day scale", () => {
  expect(ago(119 * 60, { verbose: true })).toBe("1h 59m");
  expect(ago(3600, { verbose: true })).toBe("1h");
  expect(ago(2 * 86400 + 3 * 3600, { verbose: true })).toBe("2d 3h");
  // Remainder rounding up carries rather than emitting "1h 60m"
  expect(ago(7199, { verbose: true })).toBe("2h");
  // Above a week, verbose falls back to the compact tiers
  expect(ago(20 * 86400, { verbose: true })).toBe("3w");
});

test("accepts ISO strings (the bridge wire format) and epoch ms", () => {
  expect(formatTimeAgo(new Date(NOW - 300_000).toISOString(), { now: NOW })).toBe("5m");
  expect(formatTimeAgo(NOW - 300_000, { now: NOW })).toBe("5m");
});

test("missing or unparseable input renders nothing", () => {
  expect(formatTimeAgo(null, { now: NOW })).toBe("");
  expect(formatTimeAgo(undefined, { now: NOW })).toBe("");
  expect(formatTimeAgo("", { now: NOW })).toBe("");
  expect(formatTimeAgo("not a date", { now: NOW })).toBe("");
});

test("a future timestamp (clock skew) clamps to now, never negative", () => {
  expect(formatTimeAgo(NOW + 60_000, { now: NOW })).toBe("now");
});
