import { test, expect, describe } from "bun:test";
import { handleWizardKey, getWorktreeChoices, applyRepoFilter, initWizard } from "./wizard";
import type { WizardState, WizardBranch, WizardRepo } from "../types";

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
    filteredRepos: [],
    repoIndex: 0,
    repoFilter: "",
    repoFilterCursor: 0,
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

// Repo-step fixtures: two bases, throxy has two worktrees nested after it.
const REPOS: WizardRepo[] = [
  { name: "throxy", path: "/d/throxy", currentBranch: "main", hasSession: true, worktreeCount: 2 },
  { name: "throxy", path: "/d/throxy-feat-a", currentBranch: "feature/a", isWorktree: true },
  { name: "throxy", path: "/d/throxy-tf-90", currentBranch: "tf-90-offboarding", isWorktree: true, isLastWorktree: true },
  { name: "wiki", path: "/d/wiki", currentBranch: "main", worktreeCount: 0 },
];

describe("applyRepoFilter", () => {
  test("empty filter shows base repos only, in order", () => {
    const state = baseState({ step: "repo", repos: REPOS, repoFilter: "" });
    applyRepoFilter(state);
    expect(state.filteredRepos.map((r) => r.path)).toEqual(["/d/throxy", "/d/wiki"]);
  });

  test("filtering by name narrows to matching base, prefix ranked first", () => {
    const state = baseState({ step: "repo", repos: REPOS, repoFilter: "wi" });
    applyRepoFilter(state);
    expect(state.filteredRepos[0].name).toBe("wiki");
  });

  test("a worktree branch fragment reveals that worktree", () => {
    const state = baseState({ step: "repo", repos: REPOS, repoFilter: "tf-90" });
    applyRepoFilter(state);
    expect(state.filteredRepos.map((r) => r.path)).toEqual(["/d/throxy-tf-90"]);
    expect(state.filteredRepos[0].isWorktree).toBe(true);
  });

  test("a base outranks a worktree on an equal (exact) match", () => {
    const repos: WizardRepo[] = [
      { name: "dup", path: "/d/wt", currentBranch: "dup", isWorktree: true },
      { name: "dup", path: "/d/dup", currentBranch: "main" },
    ];
    const state = baseState({ step: "repo", repos, repoFilter: "dup" });
    applyRepoFilter(state);
    expect(state.filteredRepos[0].path).toBe("/d/dup"); // base first
  });

  test("no match yields an empty list", () => {
    const state = baseState({ step: "repo", repos: REPOS, repoFilter: "zzz" });
    applyRepoFilter(state);
    expect(state.filteredRepos).toEqual([]);
  });

  test("clamps repoIndex when the filtered list shrinks", () => {
    const state = baseState({ step: "repo", repos: REPOS, repoFilter: "", repoIndex: 1 });
    applyRepoFilter(state);       // 2 bases → index 1 valid
    state.repoFilter = "wiki";
    applyRepoFilter(state);       // 1 match → index clamps to 0
    expect(state.repoIndex).toBe(0);
  });
});

describe("repo step key handling", () => {
  const repoState = (over: Partial<WizardState> = {}) => {
    const s = baseState({ step: "repo", repos: REPOS, selectedRepo: null, ...over });
    applyRepoFilter(s);
    return s;
  };

  test("ctrl+j (keyName 'linefeed') and ctrl+k ('C-k') move within bounds", () => {
    const state = repoState();
    handleWizardKey(state, "linefeed", "");
    expect(state.repoIndex).toBe(1);
    handleWizardKey(state, "linefeed", ""); // clamp at last
    expect(state.repoIndex).toBe(1);
    handleWizardKey(state, "C-k", "");
    expect(state.repoIndex).toBe(0);
    handleWizardKey(state, "C-k", ""); // clamp at 0
    expect(state.repoIndex).toBe(0);
  });

  test("typing a letter updates repoFilter and re-filters", () => {
    const state = repoState();
    handleWizardKey(state, "w", "w");
    expect(state.repoFilter).toBe("w");
    expect(state.filteredRepos.map((r) => r.name)).toContain("wiki");
  });

  test("Enter on a base advances to the branch step (loadBranches)", () => {
    const state = repoState();
    const action = handleWizardKey(state, "return", "");
    expect(action.type).toBe("loadBranches");
    expect(state.step).toBe("branch");
    expect(state.selectedRepo?.name).toBe("throxy");
  });

  test("Enter on a worktree launches directly with mode 'current'", () => {
    const state = repoState({ repoFilter: "tf-90" });
    applyRepoFilter(state);
    const action = handleWizardKey(state, "return", "");
    expect(action).toMatchObject({ type: "launch", mode: "current" });
    expect(action.type === "launch" && action.repo.path).toBe("/d/throxy-tf-90");
  });

  test("Esc cancels the wizard from the repo step", () => {
    expect(handleWizardKey(repoState(), "escape", "").type).toBe("cancel");
  });
});

describe("initWizard", () => {
  test("preselects the base repo matching the given path", () => {
    const state = initWizard(REPOS, "/d/wiki");
    expect(state?.step).toBe("repo");
    expect(state?.filteredRepos[state.repoIndex].path).toBe("/d/wiki");
  });

  test("filter state initializes empty with bases-only visible", () => {
    const state = initWizard(REPOS);
    expect(state?.repoFilter).toBe("");
    expect(state?.filteredRepos.every((r) => !r.isWorktree)).toBe(true);
  });
});

describe("branch step ctrl+j/ctrl+k navigation", () => {
  test("linefeed moves down, C-k moves up, without typing into the filter", () => {
    const state = baseState({ filteredBranches: [fb("a"), fb("b"), fb("c")], branchIndex: 0 });
    handleWizardKey(state, "linefeed", "");
    expect(state.branchIndex).toBe(1);
    expect(state.branchFilter).toBe("");
    handleWizardKey(state, "C-k", "");
    expect(state.branchIndex).toBe(0);
    expect(state.branchFilter).toBe("");
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
