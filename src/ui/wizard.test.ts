import { test, expect, describe } from "bun:test";
import { handleWizardKey, getWorktreeChoices } from "./wizard";
import type { WizardState, WizardBranch } from "../types";

const fb = (name: string, isRemote = false, isCurrent = false): WizardBranch => ({
  name,
  isRemote,
  isCurrent,
  fullRef: isRemote ? `remotes/origin/${name}` : name,
});

function baseState(over: Partial<WizardState> = {}): WizardState {
  return {
    step: "branch",
    repos: [],
    repoIndex: 0,
    selectedRepo: { name: "csm", path: "/tmp/csm", currentBranch: "main" },
    branches: [],
    filteredBranches: [],
    branchIndex: 0,
    branchFilter: "",
    branchFilterCursor: 0,
    branchFilterActive: true,
    selectedBranch: null,
    defaultBranch: "main",
    worktreeChoiceIndex: 0,
    worktreeMode: "new-branch",
    worktreeName: "",
    worktreeNameCursor: 0,
    enterDebounceUntil: 0,
    fetchState: "idle",
    ...over,
  };
}

describe("branch step: Enter picks the default worktree-choice cursor", () => {
  test("feature branch defaults the cursor to 'reuse' (index 1)", () => {
    const state = baseState({ filteredBranches: [fb("cursor/ev-4-x")], branchIndex: 0 });
    const action = handleWizardKey(state, "return", "");
    expect(action.type).toBe("render");
    expect(state.step).toBe("worktree-choice");
    expect(state.worktreeChoiceIndex).toBe(1);
  });

  test("trunk (default branch) defaults the cursor to 'new-branch' (index 0)", () => {
    const state = baseState({ filteredBranches: [fb("main")], branchIndex: 0, defaultBranch: "main" });
    handleWizardKey(state, "return", "");
    expect(state.step).toBe("worktree-choice");
    expect(state.worktreeChoiceIndex).toBe(0);
  });

  test("current branch launches directly with mode 'current'", () => {
    const branch = fb("feature", false, true);
    const state = baseState({ filteredBranches: [branch], branchIndex: 0 });
    const action = handleWizardKey(state, "return", "");
    expect(action).toMatchObject({ type: "launch", mode: "current", text: "" });
  });
});

describe("worktree-choice step", () => {
  test("j clamps at index 2, k at 0, and the third option is reachable", () => {
    const state = baseState({ step: "worktree-choice", selectedBranch: fb("feature"), worktreeChoiceIndex: 1 });
    handleWizardKey(state, "j", "");
    expect(state.worktreeChoiceIndex).toBe(2); // was 1 → reaches the new third option
    handleWizardKey(state, "j", "");
    expect(state.worktreeChoiceIndex).toBe(2); // clamped, not 3
    state.worktreeChoiceIndex = 0;
    handleWizardKey(state, "k", "");
    expect(state.worktreeChoiceIndex).toBe(0); // clamped at 0
  });

  test("Enter on 'reuse' (1) sets reuse mode and prefills a cleaned dir name", () => {
    const state = baseState({ step: "worktree-choice", selectedBranch: fb("cursor/ev-4-x"), worktreeChoiceIndex: 1 });
    handleWizardKey(state, "return", "");
    expect(state.step).toBe("worktree");
    expect(state.worktreeMode).toBe("reuse");
    expect(state.worktreeName).toBe("ev-4-x"); // cursor/ prefix stripped
  });

  test("Enter on 'new-branch' (0) prefills the branch name for local, blank for remote", () => {
    const localState = baseState({ step: "worktree-choice", selectedBranch: fb("feature"), worktreeChoiceIndex: 0 });
    handleWizardKey(localState, "return", "");
    expect(localState.worktreeMode).toBe("new-branch");
    expect(localState.worktreeName).toBe("feature");

    const remoteState = baseState({ step: "worktree-choice", selectedBranch: fb("feature", true), worktreeChoiceIndex: 0 });
    handleWizardKey(remoteState, "return", "");
    expect(remoteState.worktreeName).toBe("");
  });

  test("Enter on 'checkout' (2) returns a checkout launch action", () => {
    const state = baseState({ step: "worktree-choice", selectedBranch: fb("feature"), worktreeChoiceIndex: 2 });
    const action = handleWizardKey(state, "return", "");
    expect(action).toMatchObject({ type: "launch", mode: "checkout", text: "" });
  });

  test("Enter within the debounce window is a no-op", () => {
    const state = baseState({
      step: "worktree-choice",
      selectedBranch: fb("feature"),
      worktreeChoiceIndex: 1,
      enterDebounceUntil: Date.now() + 10_000,
    });
    const action = handleWizardKey(state, "return", "");
    expect(action.type).toBe("noop");
    expect(state.step).toBe("worktree-choice"); // did not advance
  });
});

describe("worktree step: Enter forwards mode + text to the launch action", () => {
  test("reuse mode carries worktreeMode and the typed dir name", () => {
    const state = baseState({
      step: "worktree",
      worktreeMode: "reuse",
      worktreeName: "ev-4-x",
      selectedBranch: fb("cursor/ev-4-x"),
      enterDebounceUntil: 0,
    });
    const action = handleWizardKey(state, "return", "");
    expect(action).toMatchObject({ type: "launch", mode: "reuse", text: "ev-4-x" });
  });

  test("a blank name is a no-op (no launch)", () => {
    const state = baseState({ step: "worktree", worktreeMode: "reuse", worktreeName: "  ", selectedBranch: fb("x"), enterDebounceUntil: 0 });
    expect(handleWizardKey(state, "return", "").type).toBe("noop");
  });
});

describe("getWorktreeChoices", () => {
  test("returns three options in fixed order", () => {
    const choices = getWorktreeChoices(fb("feature"));
    expect(choices.map((c) => c.label)).toEqual([
      "New worktree + new branch",
      "New worktree on this branch",
      "Checkout in place",
    ]);
  });

  test("remote branch shows a tracking hint for checkout", () => {
    expect(getWorktreeChoices(fb("feature", true))[2].hint).toContain("tracking origin");
  });
});
