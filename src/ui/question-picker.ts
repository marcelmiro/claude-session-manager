/**
 * Multi-question AskUserQuestion picker — a which-key-style overlay for answering a
 * prompt that carries several questions (the single-question case is handled inline by
 * the contextual 1-9 keys; this only opens when `questions.length > 1`).
 *
 * Step through questions with ←/→ (or n/p), select options per question with 1-9
 * (single-select replaces, multi-select toggles), then `s` to submit. Produces a
 * per-question `selections` array that the caller feeds to `buildAnswersMap` +
 * `decideQuestion` (file channel) when the focus-aware hook is holding the question,
 * falling back to `answerQuestion` send-keys for the un-intercepted native widget.
 */

import { C } from "./colors";
import type { PendingQuestion } from "../core/jsonl-reader";

export interface QuestionPickerState {
  questions: PendingQuestion[];
  step: number;
  /** picks[i]: chosen option index for single-select (−1 = unset); a Set for multi-select. */
  picks: (number | Set<number>)[];
}

export type QuestionPickerAction =
  | { type: "render" }
  | { type: "cancel" }
  | { type: "submit"; selections: (number | number[])[] };

export function createQuestionPicker(questions: PendingQuestion[]): QuestionPickerState {
  return {
    questions,
    step: 0,
    picks: questions.map((q) => (q.multiSelect ? new Set<number>() : -1)),
  };
}

/** Submit needs every single-select answered; a multi-select may be left empty. */
function ready(state: QuestionPickerState): boolean {
  return state.questions.every((q, i) =>
    q.multiSelect ? true : (state.picks[i] as number) >= 0,
  );
}

function selections(state: QuestionPickerState): (number | number[])[] {
  return state.questions.map((q, i) =>
    q.multiSelect
      ? [...(state.picks[i] as Set<number>)].sort((a, b) => a - b)
      : (state.picks[i] as number),
  );
}

// --- Rendering ---

export function renderQuestionPicker(state: QuestionPickerState): string {
  const q = state.questions[state.step]!;
  const pick = state.picks[state.step]!;
  const lines: string[] = [];
  lines.push(
    ` {bold}${q.header || "Question"}{/bold}  {${C.dim}-fg}${state.step + 1}/${state.questions.length}{/${C.dim}-fg}` +
      (q.multiSelect ? `  {${C.dim}-fg}(select all){/${C.dim}-fg}` : ""),
  );
  lines.push("");
  q.options.forEach((o, i) => {
    const selected = q.multiSelect ? (pick as Set<number>).has(i) : (pick as number) === i;
    const mark = q.multiSelect ? (selected ? "☑" : "☐") : selected ? "◉" : "◯";
    const color = selected ? C.peach : C.muted;
    lines.push(`  {${color}-fg}${mark} ${i + 1}. ${o.label}{/${color}-fg}`);
  });
  lines.push("");
  const submitColor = ready(state) ? C.mint : C.dim;
  lines.push(
    ` {${C.dim}-fg}1-9 select · ←/→ question · {/${C.dim}-fg}{${submitColor}-fg}s submit{/${submitColor}-fg}{${C.dim}-fg} · Esc cancel{/${C.dim}-fg}`,
  );
  return lines.join("\n");
}

export function getPickerDimensions(state: QuestionPickerState): { width: number; height: number } {
  const q = state.questions[state.step]!;
  const labelWidth = Math.max(
    (q.header || "Question").length + 8,
    ...q.options.map((o, i) => `  ☑ ${i + 1}. ${o.label}`.length),
    52, // room for the hint line
  );
  return { width: Math.min(labelWidth + 4, 72), height: q.options.length + 5 };
}

// --- Key handling ---

export function handleQuestionPickerKey(
  state: QuestionPickerState,
  keyName: string,
  ch: string,
): QuestionPickerAction {
  if (keyName === "escape") return { type: "cancel" };

  if (keyName === "left" || ch === "p") {
    state.step = Math.max(0, state.step - 1);
    return { type: "render" };
  }
  if (keyName === "right" || ch === "n") {
    state.step = Math.min(state.questions.length - 1, state.step + 1);
    return { type: "render" };
  }
  if (ch === "s") {
    return ready(state) ? { type: "submit", selections: selections(state) } : { type: "render" };
  }

  const num = parseInt(ch, 10);
  if (num >= 1 && num <= 9) {
    const q = state.questions[state.step]!;
    const idx = num - 1;
    if (idx < q.options.length) {
      if (q.multiSelect) {
        const set = state.picks[state.step] as Set<number>;
        set.has(idx) ? set.delete(idx) : set.add(idx);
      } else {
        state.picks[state.step] = idx;
      }
    }
    return { type: "render" };
  }

  return { type: "render" };
}
