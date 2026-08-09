/**
 * classifyActivity is the load-bearing pure core of Linux presence: every polarity
 * decision downstream (monitor push-suppression, question-hold release, hook gates)
 * keys off its three-way answer, so the boundaries are pinned exactly.
 */
import { test, expect } from "bun:test";
import { classifyActivity, PRESENCE_WINDOW_MS } from "./presence";

const NOW = 1_800_000_000_000; // ms
const sec = (ms: number) => ms / 1000;

test("no clients ⇒ absent", () => {
  expect(classifyActivity([], NOW)).toBe("absent");
});

test("activity inside the window ⇒ present (boundary inclusive)", () => {
  expect(classifyActivity([sec(NOW)], NOW)).toBe("present");
  expect(classifyActivity([sec(NOW - PRESENCE_WINDOW_MS)], NOW)).toBe("present");
});

test("activity past the window ⇒ absent", () => {
  expect(classifyActivity([sec(NOW - PRESENCE_WINDOW_MS - 1000)], NOW)).toBe("absent");
});

test("newest client wins among idle ones", () => {
  const idle = sec(NOW - 10 * PRESENCE_WINDOW_MS);
  expect(classifyActivity([idle, sec(NOW - 1000), idle], NOW)).toBe("present");
});

test("unparseable or zero epochs ⇒ unknown, not absent", () => {
  expect(classifyActivity([NaN], NOW)).toBe("unknown");
  expect(classifyActivity([0], NOW)).toBe("unknown");
  // One garbage row cannot mask a real fresh client — NaN would poison Math.max.
  expect(classifyActivity([sec(NOW), 0], NOW)).toBe("present");
  expect(classifyActivity([NaN, sec(NOW)], NOW)).toBe("present");
});
