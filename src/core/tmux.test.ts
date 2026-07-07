/**
 * Pure key-sequence builder behind `answerQuestion`. Claude's question menu is
 * numbered, so selection is by DIGIT (absolute) rather than arrow navigation —
 * verified live: batched `Down`×n dropped the arrows and picked the default option.
 */

import { test, expect } from "bun:test";
import { questionAnswerKeys, multiQuestionKeys, answerKeys } from "./tmux";

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

// --- Multi-question prompts (N>1), LIVE-VERIFIED model (2026-07-01): Left×N resets to
//     Q1; single-select digit auto-advances (no Right); multi-select digit(s) + Right;
//     land on Submit, then Enter. ---

test("multiQuestionKeys: two questions (single + multi)", () => {
  // Q1 single-select index 2 → "3" (auto-advances); Q2 multi-select [0] → "1" then Right.
  expect(multiQuestionKeys([2, [0]])).toEqual([
    "Left", "Left", // reset to first question tab
    "3",             // Q1 single: selects + auto-advances to Q2
    "1", "Right",    // Q2 multi: toggle, then step onto Submit
    "Enter",         // submit
  ]);
});

test("multiQuestionKeys: all single-select — each digit auto-advances, no Right", () => {
  // Verified live: Size=idx1 "2", Speed=idx1 "2" → Medium/Fast with no explicit Right.
  expect(multiQuestionKeys([1, 1])).toEqual(["Left", "Left", "2", "2", "Enter"]);
});

test("multiQuestionKeys: empty multi-select still steps past its question", () => {
  // Q1 single-select index 0 → "1" (auto-advance); Q2 empty multi-select → just Right.
  expect(multiQuestionKeys([0, []])).toEqual(["Left", "Left", "1", "Right", "Enter"]);
});

test("multiQuestionKeys: multi-select digits are de-duped and sorted", () => {
  // Q1 multi [2,0,0] → "1","3",Right; Q2 single index 1 → "2" (auto-advance).
  expect(multiQuestionKeys([[2, 0, 0], 1])).toEqual([
    "Left", "Left", "1", "3", "Right", "2", "Enter",
  ]);
});

test("answerKeys dispatches single-question to questionAnswerKeys (no reset/extra Right)", () => {
  expect(answerKeys([2])).toEqual(questionAnswerKeys(2)); // ["3", "Enter"]
  expect(answerKeys([[0, 2]])).toEqual(questionAnswerKeys([0, 2])); // ["1","3","Right","Enter"]
});

test("answerKeys dispatches multi-question to multiQuestionKeys", () => {
  expect(answerKeys([2, [0]])).toEqual(multiQuestionKeys([2, [0]]));
});
