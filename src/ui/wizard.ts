import type { Widgets } from "blessed";
import { homedir } from "os";
import type { WizardState, WizardRepo, WizardBranch, WizardAction } from "../types";
import { C } from "./colors";
import { ansiToBlessedMarkup } from "./preview-pane";
import { getBranchLog } from "../core/git";
import { handleTextInputKey, renderTextWithCursor } from "./text-input";

/**
 * Create initial wizard state. Returns null if no repos found.
 * Auto-advances past repo step if only 1 repo.
 */
export function initWizard(
  sessionRepos: WizardRepo[],
  preselectedRepo?: string,
): WizardState | null {
  if (sessionRepos.length === 0) return null;

  // Find preselected repo index
  let repoIndex = 0;
  if (preselectedRepo) {
    const idx = sessionRepos.findIndex((r) => r.path === preselectedRepo);
    if (idx >= 0) repoIndex = idx;
  }

  const state: WizardState = {
    step: "repo",
    repos: sessionRepos,
    repoIndex,
    selectedRepo: null,
    branches: [],
    filteredBranches: [],
    branchIndex: 0,
    branchFilter: "",
    branchFilterCursor: 0,
    branchFilterActive: false,
    selectedBranch: null,
    worktreeChoiceIndex: 0,
    worktreeName: "",
    worktreeNameCursor: 0,
    enterDebounceUntil: 0,
  };

  // Auto-skip repo step if only one repo
  if (sessionRepos.length === 1) {
    state.selectedRepo = sessionRepos[0];
    state.step = "branch";
    state.branchFilterActive = true;
  }

  return state;
}

/**
 * Render wizard content into the list box.
 */
export function renderWizard(listBox: Widgets.BoxElement, state: WizardState): void {
  const lines: string[] = [];

  // Breadcrumb header
  lines.push(renderBreadcrumb(state));
  lines.push("");

  if (state.step === "repo") {
    renderRepoStep(lines, listBox, state);
  } else if (state.step === "branch") {
    renderBranchStep(lines, listBox, state);
  } else if (state.step === "worktree-choice") {
    renderWorktreeChoiceStep(lines, state);
  } else if (state.step === "worktree") {
    renderWorktreeStep(lines, state);
  }

  listBox.setContent(lines.join("\n"));

  // Scroll to keep cursor visible
  const selectedLine = getSelectedLine(state);
  if (selectedLine >= 0) {
    const boxHeight = typeof listBox.height === "number" ? listBox.height - 2 : 20;
    const scrollPos = (listBox as any).childBase || 0;
    if (selectedLine < scrollPos) {
      listBox.scrollTo(selectedLine);
    } else if (selectedLine >= scrollPos + boxHeight) {
      listBox.scrollTo(selectedLine - boxHeight + 1);
    }
  }
}

function getSelectedLine(state: WizardState): number {
  const headerLines = 2; // breadcrumb + blank
  if (state.step === "repo") return headerLines + state.repoIndex;
  if (state.step === "branch") {
    return headerLines + 1 + state.branchIndex; // +1 for always-visible filter bar
  }
  if (state.step === "worktree-choice") return headerLines + state.worktreeChoiceIndex;
  if (state.step === "worktree") return headerLines + 2; // instruction + blank + input line
  return -1;
}

function renderBreadcrumb(state: WizardState): string {
  const parts: string[] = [`{${C.peach}-fg}New Session{/${C.peach}-fg}`];
  if (state.selectedRepo) {
    parts.push(`{${C.dim}-fg}>{/${C.dim}-fg} {${C.fg}-fg}${state.selectedRepo.name}{/${C.fg}-fg}`);
  }
  if (state.selectedBranch) {
    parts.push(`{${C.dim}-fg}>{/${C.dim}-fg} {${C.fg}-fg}${state.selectedBranch.name}{/${C.fg}-fg}`);
  }
  return `  ${parts.join(" ")}`;
}

/** Compute worktree directory path from repo name + branch name. Sanitizes / → - for flat sibling dirs. */
export function worktreeDirName(repoName: string, branchName: string): string {
  return `../${repoName}-${branchName.replace(/\//g, "-")}`;
}

function abbreviatePath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

function renderRepoStep(lines: string[], listBox: Widgets.BoxElement, state: WizardState): void {
  const boxWidth = typeof listBox.width === "number" ? listBox.width : 60;

  for (let i = 0; i < state.repos.length; i++) {
    const repo = state.repos[i];
    const isSelected = i === state.repoIndex;
    const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg}` : " ";
    const abbrevPath = abbreviatePath(repo.path);

    // Name cell: base repos show their name; worktrees show their branch, tree-indented.
    // Build the plain string (for width-aware padding) and the colored markup separately.
    let namePlain: string;
    let nameColored: string;
    if (repo.isWorktree) {
      const conn = repo.isLastWorktree ? "└" : "├";
      const label = repo.currentBranch;
      namePlain = `  ${conn} ${label}`;
      const labelColor = isSelected ? C.fg : C.muted;
      nameColored = `  {${C.dim}-fg}${conn}{/${C.dim}-fg} {${labelColor}-fg}${label}{/${labelColor}-fg}`;
    } else {
      namePlain = repo.name;
      nameColored = isSelected
        ? `{bold}{${C.fg}-fg}${repo.name}{/${C.fg}-fg}{/bold}`
        : `{${C.muted}-fg}${repo.name}{/${C.muted}-fg}`;
    }
    const namePad = " ".repeat(Math.max(1, 20 - namePlain.length));

    // Right column: base repos show their branch; worktrees a "worktree" tag.
    const rightLabel = repo.isWorktree ? "worktree" : repo.currentBranch;
    const maxPathLen = Math.max(10, boxWidth - 30 - rightLabel.length);
    const pathStr = abbrevPath.length > maxPathLen ? "…" + abbrevPath.slice(-maxPathLen + 1) : abbrevPath;
    const rightStr = `{${C.dim}-fg}${rightLabel}{/${C.dim}-fg}`;

    if (isSelected) {
      lines.push(
        `{${C.surface}-bg} ${cursor} ${nameColored}${namePad}` +
        `{${C.muted}-fg}${pathStr.padEnd(maxPathLen)}{/${C.muted}-fg} ${rightStr}{/${C.surface}-bg}`,
      );
    } else {
      lines.push(
        ` ${cursor} ${nameColored}${namePad}` +
        `{${C.dim}-fg}${pathStr.padEnd(maxPathLen)}{/${C.dim}-fg} ${rightStr}`,
      );
    }
  }
}

function renderBranchStep(lines: string[], _listBox: Widgets.BoxElement, state: WizardState): void {
  // Filter bar (always visible — type to search)
  lines.push(`  {${C.peach}-fg}/{/${C.peach}-fg} ${renderTextWithCursor(state.branchFilter, state.branchFilterCursor)}`);

  const branches = state.filteredBranches;

  if (branches.length === 0) {
    lines.push(`  {${C.dim}-fg}${state.branchFilter ? "No matching branches" : "No branches found"}{/${C.dim}-fg}`);
    return;
  }

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i];
    const isSelected = i === state.branchIndex;
    const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg}` : " ";
    const currentMarker = branch.isCurrent ? ` {${C.mint}-fg}●{/${C.mint}-fg}` : "";
    const display = branch.fullRef;

    if (isSelected) {
      if (branch.isRemote) {
        lines.push(
          `{${C.surface}-bg} ${cursor} {${C.muted}-fg}${display}{/${C.muted}-fg}${currentMarker}{/${C.surface}-bg}`,
        );
      } else {
        lines.push(
          `{${C.surface}-bg} ${cursor} {bold}{${C.fg}-fg}${display}{/${C.fg}-fg}{/bold}${currentMarker}{/${C.surface}-bg}`,
        );
      }
    } else {
      if (branch.isRemote) {
        lines.push(
          ` ${cursor} {${C.dim}-fg}${display}{/${C.dim}-fg}${currentMarker}`,
        );
      } else {
        lines.push(
          ` ${cursor} {${C.muted}-fg}${display}{/${C.muted}-fg}${currentMarker}`,
        );
      }
    }
  }
}

function renderWorktreeChoiceStep(lines: string[], state: WizardState): void {
  const branch = state.selectedBranch!;
  const repo = state.selectedRepo!;

  const choices = getWorktreeChoices(branch, repo);

  for (let i = 0; i < choices.length; i++) {
    const isSelected = i === state.worktreeChoiceIndex;
    const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg}` : " ";
    const dot = isSelected ? "●" : "○";
    const label = choices[i].label;
    const hint = choices[i].hint;

    if (isSelected) {
      lines.push(
        `{${C.surface}-bg} ${cursor} ${dot} {bold}{${C.fg}-fg}${label}{/${C.fg}-fg}{/bold}` +
        `  {${C.dim}-fg}${hint}{/${C.dim}-fg}{/${C.surface}-bg}`,
      );
    } else {
      lines.push(
        ` ${cursor} {${C.dim}-fg}${dot}{/${C.dim}-fg} {${C.muted}-fg}${label}{/${C.muted}-fg}` +
        `  {${C.dim}-fg}${hint}{/${C.dim}-fg}`,
      );
    }
  }
}

function getWorktreeChoices(branch: WizardBranch, repo: WizardRepo): Array<{ label: string; hint: string }> {
  if (branch.isRemote) {
    return [
      { label: "Checkout locally", hint: `create local ${branch.name} tracking origin` },
      { label: "New worktree", hint: `new branch off origin/${branch.name}` },
    ];
  }
  return [
    { label: "Switch branch", hint: `checkout ${branch.name}` },
    { label: "New worktree", hint: `worktree on ${branch.name}` },
  ];
}

function renderWorktreeStep(lines: string[], state: WizardState): void {
  const repo = state.selectedRepo!;
  const branch = state.selectedBranch!;

  lines.push(`  {${C.muted}-fg}New branch name:{/${C.muted}-fg}`);
  lines.push("");
  lines.push(`{${C.surface}-bg}  {${C.peach}-fg}>{/${C.peach}-fg} ${renderTextWithCursor(state.worktreeName, state.worktreeNameCursor)}{/${C.surface}-bg}`);

  if (state.worktreeName) {
    const wtPath = worktreeDirName(repo.name, state.worktreeName);
    const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
    lines.push("");
    lines.push(`  {${C.dim}-fg}Path:{/${C.dim}-fg}    {${C.fg}-fg}${wtPath}{/${C.fg}-fg}`);
    lines.push(`  {${C.dim}-fg}Command:{/${C.dim}-fg} {${C.mint}-fg}git worktree add ${wtPath} -b ${state.worktreeName} ${baseRef}{/${C.mint}-fg}`);
  } else {
    lines.push("");
    lines.push(`  {${C.dim}-fg}Type a branch name to create a worktree{/${C.dim}-fg}`);
  }
}

/**
 * Render contextual preview for wizard state.
 */
export async function renderWizardPreview(previewBox: Widgets.BoxElement, state: WizardState): Promise<void> {
  if (state.step === "repo") {
    const sel = state.repos[state.repoIndex];
    if (sel?.isWorktree) {
      previewBox.setContent(
        `{${C.muted}-fg}  Worktree{/${C.muted}-fg}\n\n` +
        `  {${C.dim}-fg}Branch:{/${C.dim}-fg} {${C.fg}-fg}${sel.currentBranch}{/${C.fg}-fg}\n` +
        `  {${C.dim}-fg}Path:{/${C.dim}-fg}   {${C.fg}-fg}${abbreviatePath(sel.path)}{/${C.fg}-fg}\n\n` +
        `  {${C.dim}-fg}⏎ launches Claude here directly{/${C.dim}-fg}`,
      );
    } else {
      previewBox.setContent(
        `\n{${C.muted}-fg}  Select a repo to start a new Claude session{/${C.muted}-fg}`,
      );
    }
    return;
  }

  if (state.step === "branch") {
    const branches = state.filteredBranches;
    if (branches.length === 0 || state.branchIndex >= branches.length) {
      previewBox.setContent("");
      return;
    }
    const branch = branches[state.branchIndex];
    const repo = state.selectedRepo!;
    const log = await getBranchLog(repo.path, branch.isRemote ? `origin/${branch.name}` : branch.name);
    if (log) {
      const markup = ansiToBlessedMarkup(log);
      previewBox.setContent(`{${C.muted}-fg}  ${branch.name}{/${C.muted}-fg}\n\n${markup}`);
    } else {
      previewBox.setContent(`{${C.dim}-fg}  No log available{/${C.dim}-fg}`);
    }
    return;
  }

  if (state.step === "worktree-choice") {
    const repo = state.selectedRepo!;
    const branch = state.selectedBranch!;
    const lines: string[] = [
      `{${C.muted}-fg}  Summary{/${C.muted}-fg}`,
      "",
      `  {${C.dim}-fg}Repo:{/${C.dim}-fg}   {${C.fg}-fg}${repo.name}{/${C.fg}-fg}`,
      `  {${C.dim}-fg}Base:{/${C.dim}-fg}   {${C.fg}-fg}${branch.fullRef}{/${C.fg}-fg}`,
    ];

    if (state.worktreeChoiceIndex === 0) {
      // Switch/checkout preview
      if (branch.isRemote) {
        lines.push(
          "",
          `  {${C.dim}-fg}Command:{/${C.dim}-fg}`,
          `  {${C.mint}-fg}git checkout -b ${branch.name} --track origin/${branch.name}{/${C.mint}-fg}`,
        );
      } else {
        lines.push(
          "",
          `  {${C.dim}-fg}Command:{/${C.dim}-fg}`,
          `  {${C.mint}-fg}git checkout ${branch.name}{/${C.mint}-fg}`,
        );
      }
    } else {
      // Worktree preview
      const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
      lines.push(
        "",
        `  {${C.dim}-fg}Will create a new worktree off ${baseRef}{/${C.dim}-fg}`,
      );
    }

    previewBox.setContent(lines.join("\n"));
  }

  if (state.step === "worktree") {
    const repo = state.selectedRepo!;
    const branch = state.selectedBranch!;
    const lines: string[] = [
      `{${C.muted}-fg}  Summary{/${C.muted}-fg}`,
      "",
      `  {${C.dim}-fg}Repo:{/${C.dim}-fg}   {${C.fg}-fg}${repo.name}{/${C.fg}-fg}`,
      `  {${C.dim}-fg}Base:{/${C.dim}-fg}   {${C.fg}-fg}${branch.fullRef}{/${C.fg}-fg}`,
    ];

    if (state.worktreeName) {
      const wtPath = worktreeDirName(repo.name, state.worktreeName);
      const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
      lines.push(
        `  {${C.dim}-fg}Branch:{/${C.dim}-fg} {${C.fg}-fg}${state.worktreeName}{/${C.fg}-fg}`,
        "",
        `  {${C.dim}-fg}Command:{/${C.dim}-fg}`,
        `  {${C.mint}-fg}git worktree add ${wtPath} -b ${state.worktreeName} ${baseRef}{/${C.mint}-fg}`,
      );
    } else {
      lines.push(
        "",
        `  {${C.dim}-fg}Enter a branch name for the worktree{/${C.dim}-fg}`,
      );
    }

    previewBox.setContent(lines.join("\n"));
  }
}

/**
 * Render wizard-specific status bar hints.
 */
export function renderWizardStatusBar(statusBar: Widgets.BoxElement, state: WizardState): void {
  let content = "";

  if (state.step === "repo") {
    content =
      `{${C.peach}-fg}j/k{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}select{/${C.dim}-fg}` +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}cancel{/${C.dim}-fg}`;
  } else if (state.step === "branch") {
    content =
      `{${C.peach}-fg}↑/↓{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
      `  {${C.peach}-fg}type{/${C.peach}-fg} {${C.dim}-fg}to filter{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}select{/${C.dim}-fg}` +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}back{/${C.dim}-fg}`;
  } else if (state.step === "worktree-choice") {
    content =
      `{${C.peach}-fg}j/k{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}select{/${C.dim}-fg}` +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}back{/${C.dim}-fg}`;
  } else if (state.step === "worktree") {
    content =
      `{${C.peach}-fg}type{/${C.peach}-fg} {${C.dim}-fg}branch name{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}launch{/${C.dim}-fg}` +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}back{/${C.dim}-fg}`;
  }

  statusBar.setContent(content);
}

/**
 * Pure state machine for wizard key handling. Returns a WizardAction.
 */
export function handleWizardKey(state: WizardState, keyName: string, ch: string): WizardAction {
  if (state.step === "repo") {
    return handleRepoKey(state, keyName);
  } else if (state.step === "branch") {
    return handleBranchFilterKey(state, keyName, ch);
  } else if (state.step === "worktree-choice") {
    return handleWorktreeChoiceKey(state, keyName);
  } else if (state.step === "worktree") {
    return handleWorktreeKey(state, keyName, ch);
  }

  return { type: "noop" };
}

function handleRepoKey(state: WizardState, keyName: string): WizardAction {
  switch (keyName) {
    case "j":
    case "down":
      state.repoIndex = Math.min(state.repoIndex + 1, state.repos.length - 1);
      return { type: "render" };
    case "k":
    case "up":
      state.repoIndex = Math.max(state.repoIndex - 1, 0);
      return { type: "render" };
    case "enter":
    case "return": {
      const sel = state.repos[state.repoIndex];
      state.selectedRepo = sel;
      if (sel.isWorktree) {
        // Existing worktree: launch Claude there directly on its current branch.
        const branch: WizardBranch = { name: sel.currentBranch, isRemote: false, isCurrent: true, fullRef: sel.currentBranch };
        state.selectedBranch = branch;
        return { type: "launch", repo: sel, branch, worktreeName: "" };
      }
      state.step = "branch";
      state.branchIndex = 0;
      state.branchFilter = "";
      state.branchFilterCursor = 0;
      state.branchFilterActive = true;
      return { type: "loadBranches" };
    }
    case "escape":
      return { type: "cancel" };
    case "q":
      return { type: "quit" };
    default:
      return { type: "noop" };
  }
}

function handleBranchFilterKey(state: WizardState, keyName: string, ch: string): WizardAction {
  // Step-specific keys first
  switch (keyName) {
    case "escape":
      // Go back to repo step (or cancel if only one repo)
      if (state.repos.length === 1) {
        return { type: "cancel" };
      }
      state.step = "repo";
      state.selectedRepo = null;
      state.branches = [];
      state.filteredBranches = [];
      state.branchFilter = "";
      state.branchFilterCursor = 0;
      state.branchFilterActive = false;
      return { type: "render" };
    case "up":
      if (state.filteredBranches.length > 0) {
        state.branchIndex = Math.max(state.branchIndex - 1, 0);
        return { type: "preview" };
      }
      return { type: "noop" };
    case "down":
      if (state.filteredBranches.length > 0) {
        state.branchIndex = Math.min(state.branchIndex + 1, state.filteredBranches.length - 1);
        return { type: "preview" };
      }
      return { type: "noop" };
    case "enter":
    case "return": {
      if (state.filteredBranches.length === 0) return { type: "noop" };
      const branch = state.filteredBranches[state.branchIndex];
      state.selectedBranch = branch;

      if (branch.isCurrent) {
        // Current branch: launch directly, no chooser needed
        return { type: "launch", repo: state.selectedRepo!, branch, worktreeName: "" };
      }

      state.step = "worktree-choice";
      state.worktreeChoiceIndex = 0;
      state.enterDebounceUntil = Date.now() + 100;
      return { type: "render" };
    }
  }

  // Centralized text input handling
  const prevText = state.branchFilter;
  const prevCursor = state.branchFilterCursor;
  const result = handleTextInputKey(state.branchFilter, state.branchFilterCursor, keyName, ch);
  if (result.handled) {
    state.branchFilter = result.text;
    state.branchFilterCursor = result.cursor;
    if (result.text !== prevText) {
      applyBranchFilter(state);
    }
    if (result.text !== prevText || result.cursor !== prevCursor) {
      return { type: "preview" };
    }
    return { type: "noop" };
  }

  return { type: "noop" };
}

function applyBranchFilter(state: WizardState): void {
  const filter = state.branchFilter.toLowerCase();
  if (!filter) {
    state.filteredBranches = state.branches;
  } else {
    // Filter and rank: exact name > prefix > contains, local before remote
    const scored = state.branches
      .map((b, i) => ({ branch: b, index: i, score: scoreBranchMatch(b, filter) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    state.filteredBranches = scored.map((x) => x.branch);
  }
  state.branchIndex = Math.min(state.branchIndex, Math.max(0, state.filteredBranches.length - 1));
}

function scoreBranchMatch(branch: WizardBranch, filter: string): number {
  const name = branch.name.toLowerCase();
  const ref = branch.fullRef.toLowerCase();
  const local = branch.isRemote ? 0 : 1;

  if (name === filter) return 60 + local;          // exact name match
  if (name.startsWith(filter)) return 40 + local;  // name prefix
  if (name.includes(filter)) return 20 + local;    // name contains
  if (ref.includes(filter)) return 10;              // match in remotes/origin/ prefix
  return 0;
}

function handleWorktreeChoiceKey(state: WizardState, keyName: string): WizardAction {
  switch (keyName) {
    case "j":
    case "down":
      state.worktreeChoiceIndex = Math.min(state.worktreeChoiceIndex + 1, 1);
      return { type: "render" };
    case "k":
    case "up":
      state.worktreeChoiceIndex = Math.max(state.worktreeChoiceIndex - 1, 0);
      return { type: "render" };
    case "enter":
    case "return": {
      if (Date.now() < state.enterDebounceUntil) return { type: "noop" };
      const branch = state.selectedBranch!;
      const repo = state.selectedRepo!;

      if (state.worktreeChoiceIndex === 0) {
        // Switch branch / Checkout locally → launch directly
        return { type: "launch", repo, branch, worktreeName: "" };
      }

      // New worktree → advance to name input
      state.step = "worktree";
      // Prefill: local branch name for local, blank for remote
      const prefill = branch.isRemote ? "" : branch.name;
      state.worktreeName = prefill;
      state.worktreeNameCursor = prefill.length;
      state.enterDebounceUntil = Date.now() + 100;
      return { type: "render" };
    }
    case "escape":
      // Back to branch step
      state.step = "branch";
      state.selectedBranch = null;
      state.worktreeChoiceIndex = 0;
      state.branchFilterActive = true;
      return { type: "preview" };
    default:
      return { type: "noop" };
  }
}

function handleWorktreeKey(state: WizardState, keyName: string, ch: string): WizardAction {
  // Step-specific keys first
  switch (keyName) {
    case "enter":
    case "return": {
      if (Date.now() < state.enterDebounceUntil) return { type: "noop" };
      if (!state.worktreeName.trim()) return { type: "noop" };
      const repo = state.selectedRepo!;
      const branch = state.selectedBranch!;
      return { type: "launch", repo, branch, worktreeName: state.worktreeName };
    }
    case "escape":
      // Go back to worktree-choice step
      state.step = "worktree-choice";
      state.worktreeName = "";
      state.worktreeNameCursor = 0;
      return { type: "render" };
  }

  // Centralized text input handling (only valid git branch chars)
  const prevText = state.worktreeName;
  const prevCursor = state.worktreeNameCursor;
  const result = handleTextInputKey(state.worktreeName, state.worktreeNameCursor, keyName, ch, /[a-zA-Z0-9._\-\/]/);
  if (result.handled) {
    state.worktreeName = result.text;
    state.worktreeNameCursor = result.cursor;
    if (result.text !== prevText || result.cursor !== prevCursor) {
      return { type: "render" };
    }
    return { type: "noop" };
  }

  return { type: "noop" };
}
