/**
 * Pure key-sequence builder behind `answerQuestion`. Claude's question menu is
 * numbered, so selection is by DIGIT (absolute) rather than arrow navigation —
 * verified live: batched `Down`×n dropped the arrows and picked the default option.
 */

import { test, expect } from "bun:test";
import { questionAnswerKeys } from "./tmux";

test("single-select presses the option's 1-based digit, then Enter to submit", () => {
  expect(questionAnswerKeys(0)).toEqual(["1", "Enter"]);
  expect(questionAnswerKeys(2)).toEqual(["3", "Enter"]);
});

test("multiSelect toggles each option's digit, then Right+Enter (Submit tab)", () => {
  // indices 1 and 3 → digits 2 and 4, then submit.
  expect(questionAnswerKeys([1, 3])).toEqual(["2", "4", "Right", "Enter"]);
});

test("multiSelect de-dupes and sorts the indices", () => {
  expect(questionAnswerKeys([3, 1, 1])).toEqual(questionAnswerKeys([1, 3]));
});

test("multiSelect at index 0 → digit 1 then submit", () => {
  expect(questionAnswerKeys([0])).toEqual(["1", "Right", "Enter"]);
});
