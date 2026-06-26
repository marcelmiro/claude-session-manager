/**
 * Pure key-sequence builder behind `answerQuestion` (A8). No tmux/send-keys — the
 * side effect was split off into `sendKeys`, leaving this fully unit-testable.
 */

import { test, expect } from "bun:test";
import { questionAnswerKeys } from "./tmux";

test("single-select n → Down×n then Enter", () => {
  expect(questionAnswerKeys(0)).toEqual(["Enter"]);
  expect(questionAnswerKeys(2)).toEqual(["Down", "Down", "Enter"]);
});

test("multiSelect → Down-deltas + Space per index, ending Right+Enter (Submit tab)", () => {
  // indices 1 and 3: Down to 1 (×1) Space, Down to 3 (×2) Space, then Right+Enter.
  expect(questionAnswerKeys([1, 3])).toEqual([
    "Down",
    "Space",
    "Down",
    "Down",
    "Space",
    "Right",
    "Enter",
  ]);
});

test("multiSelect de-dupes and sorts the indices", () => {
  expect(questionAnswerKeys([3, 1, 1])).toEqual(questionAnswerKeys([1, 3]));
});

test("multiSelect starting at index 0 toggles without leading Down", () => {
  expect(questionAnswerKeys([0])).toEqual(["Space", "Right", "Enter"]);
});
