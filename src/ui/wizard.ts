import type { Widgets } from "blessed";
import { homedir } from "os";
import type { WizardState, WizardRepo, WizardBranch, WizardAction } from "../types";
import { C } from "./colors";
import { ansiToBlessedMarkup } from "./preview-pane";
import { getBranchLog, cleanBranchToDir } from "../core/git";
import { worktreeDirName } from "../core/launch-command";
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

  const state: WizardState = {
    step: "repo",
    repos: sessionRepos,
    filteredRepos: [],
    repoIndex: 0,
    repoFilter: "",
    repoFilterCursor: 0,
    expandedRepos: [],
    selectedRepo: null,
    branches: [],
    filteredBranches: [],
    branchIndex: 0,
    branchFilter: "",
    branchFilterCursor: 0,
    branchFilterActive: false,
    selectedBranch: null,
    defaultBranch: "",
    worktreeChoiceIndex: 0,
    worktreeMode: "new-branch",
    worktreeName: "",
    worktreeNameCursor: 0,
    enterDebounceUntil: 0,
    fetchState: "idle",
  };

  // Seed the visible list (empty filter → bases only) and place the cursor on
  // the preselected base repo if one was given.
  applyRepoFilter(state);
  if (preselectedRepo) {
    const idx = state.filteredRepos.findIndex((r) => r.path === preselectedRepo);
    if (idx >= 0) state.repoIndex = idx;
  }

  // Auto-skip repo step if only one repo
  if (sessionRepos.length === 1) {
    state.selectedRepo = sessionRepos[0];
    state.step = "branch";
    state.branchFilterActive = true;
  }

  return state;
}

/**
 * Rebuild `filteredRepos` from `repoFilter`. Empty filter → the browse view:
 * base repos in discovery order, each followed by its worktrees only when that
 * base is expanded (`expandedRepos`). Non-empty → flat scored matches: bases by
 * name, worktrees by branch *or* their base repo name, exact > prefix >
 * contains, bases before worktrees on ties, non-matches dropped. Clamps
 * `repoIndex` into range.
 */
export function applyRepoFilter(state: WizardState): void {
  const filter = state.repoFilter.toLowerCase();
  if (!filter) {
    // Worktrees follow their base in `repos`, so track the last base while
    // walking and include its worktrees only when it's expanded.
    const visible: WizardRepo[] = [];
    let baseExpanded = false;
    for (const r of state.repos) {
      if (!r.isWorktree) {
        baseExpanded = state.expandedRepos.includes(r.path);
        visible.push(r);
      } else if (baseExpanded) {
        visible.push(r);
      }
    }
    state.filteredRepos = visible;
  } else {
    const scored = state.repos
      .map((r, i) => ({ repo: r, index: i, score: scoreRepoMatch(r, filter) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index);
    state.filteredRepos = scored.map((x) => x.repo);
  }
  state.repoIndex = Math.min(state.repoIndex, Math.max(0, state.filteredRepos.length - 1));
}

/** Tier a haystack against a lowercased filter: exact > prefix > contains > none. */
function matchTier(hay: string, filter: string): number {
  if (hay === filter) return 60;
  if (hay.startsWith(filter)) return 40;
  if (hay.includes(filter)) return 20;
  return 0;
}

/**
 * Score a repo row against a lowercased filter. Bases match on name; worktrees
 * match on their branch OR their base repo name (so typing the repo name
 * reveals its worktrees, not just the base row).
 */
function scoreRepoMatch(repo: WizardRepo, filter: string): number {
  if (!repo.isWorktree) {
    const s = matchTier(repo.name.toLowerCase(), filter);
    return s > 0 ? s + 1 : 0; // bases outrank worktrees on ties
  }
  const s = Math.max(
    matchTier(repo.currentBranch.toLowerCase(), filter),
    matchTier(repo.name.toLowerCase(), filter),
  );
  return s;
}

/** Set a base repo's expanded state, rebuild the visible list, keep the cursor on it. */
function setRepoExpanded(state: WizardState, path: string, expanded: boolean): void {
  const has = state.expandedRepos.includes(path);
  if (expanded && !has) state.expandedRepos.push(path);
  else if (!expanded && has) state.expandedRepos = state.expandedRepos.filter((p) => p !== path);
  applyRepoFilter(state);
  const idx = state.filteredRepos.findIndex((r) => r.path === path);
  if (idx >= 0) state.repoIndex = idx;
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
  if (state.step === "repo") return headerLines + 1 + state.repoIndex; // +1 for always-visible filter bar
  if (state.step === "branch") {
    return headerLines + 1 + state.branchIndex; // +1 for always-visible filter bar
  }
  if (state.step === "worktree-choice") return headerLines + state.worktreeChoiceIndex;
  // input line = instruction + blank; reuse mode prepends a read-only "Branch:" line.
  if (state.step === "worktree") return headerLines + (state.worktreeMode === "reuse" ? 3 : 2);
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

/** True when the branch is the repo's trunk (default branch, or main/master when unknown). */
export function isTrunk(branch: WizardBranch, defaultBranch: string): boolean {
  const trunk = defaultBranch || "main";
  return branch.name === trunk || branch.name === "main" || branch.name === "master";
}

function abbreviatePath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? "~" + path.slice(home.length) : path;
}

/** Truncate a plain label to `max` chars, appending an ellipsis when clipped. */
function truncLabel(s: string, max: number): string {
  if (max < 1) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function renderRepoStep(lines: string[], listBox: Widgets.BoxElement, state: WizardState): void {
  const boxWidth = typeof listBox.width === "number" ? listBox.width : 60;

  // Always-visible filter bar (type to search). Worktrees are collapsed until
  // the query matches a base name or a worktree branch.
  lines.push(`  {${C.peach}-fg}/{/${C.peach}-fg} ${renderTextWithCursor(state.repoFilter, state.repoFilterCursor)}`);

  if (state.filteredRepos.length === 0) {
    lines.push(`  {${C.dim}-fg}${state.repoFilter ? "No matching repos" : "No repos found"}{/${C.dim}-fg}`);
    return;
  }

  for (let i = 0; i < state.filteredRepos.length; i++) {
    const repo = state.filteredRepos[i];
    const isSelected = i === state.repoIndex;
    const cursor = isSelected ? `{${C.peach}-fg}▸{/${C.peach}-fg}` : " ";

    // Compose plain text first for width-aware truncation, then color it.
    let body: string;
    if (repo.isWorktree) {
      const labelColor = isSelected ? C.fg : C.muted;
      if (state.repoFilter) {
        // Filtered flat view: worktrees can appear detached from their base, so
        // show the branch plus its base repo for context. Budget reserves the
        // "▸ " cursor prefix (6) AND the "└ " connector (2), so it never wraps.
        const suffix = `  ${repo.name}`;
        const label = truncLabel(repo.currentBranch, Math.max(8, boxWidth - 8 - suffix.length));
        body =
          `{${C.dim}-fg}└{/${C.dim}-fg} {${labelColor}-fg}${label}{/${labelColor}-fg}` +
          `  {${C.dim}-fg}${repo.name}{/${C.dim}-fg}`;
      } else {
        // Browse view: nested under its (visible) base, no redundant repo suffix.
        const conn = repo.isLastWorktree ? "└" : "├";
        const label = truncLabel(repo.currentBranch, Math.max(8, boxWidth - 8));
        body = `{${C.dim}-fg}${conn}{/${C.dim}-fg} {${labelColor}-fg}${label}{/${labelColor}-fg}`;
      }
    } else {
      // Chevron affordance: bases with worktrees show expand state + count.
      const chev = repo.worktreeCount
        ? (state.expandedRepos.includes(repo.path) ? "▾ " : "▸ ")
        : "";
      const badge = repo.worktreeCount ? ` ${chev}${repo.worktreeCount}` : "";
      // Show the branch only when it isn't the trunk (main/master).
      const offTrunk = repo.currentBranch && repo.currentBranch !== "main" && repo.currentBranch !== "master";
      const branchTag = offTrunk ? `  ${repo.currentBranch}` : "";
      const label = truncLabel(repo.name, Math.max(8, boxWidth - 6 - badge.length - branchTag.length));
      const nameColored = isSelected
        ? `{bold}{${C.fg}-fg}${label}{/${C.fg}-fg}{/bold}`
        : `{${C.muted}-fg}${label}{/${C.muted}-fg}`;
      body =
        `${nameColored}${badge ? `{${C.dim}-fg}${badge}{/${C.dim}-fg}` : ""}` +
        `${branchTag ? `{${C.dim}-fg}${branchTag}{/${C.dim}-fg}` : ""}`;
    }

    if (isSelected) {
      lines.push(`{${C.surface}-bg} ${cursor} ${body}{/${C.surface}-bg}`);
    } else {
      lines.push(` ${cursor} ${body}`);
    }
  }
}

function renderBranchStep(lines: string[], _listBox: Widgets.BoxElement, state: WizardState): void {
  // Filter bar (always visible — type to search). A background `git fetch` runs
  // on entry so branches pushed by others show up without leaving the wizard.
  const fetchTag = state.fetchState === "fetching"
    ? `   {${C.dim}-fg}⟳ fetching…{/${C.dim}-fg}`
    : "";
  lines.push(`  {${C.peach}-fg}/{/${C.peach}-fg} ${renderTextWithCursor(state.branchFilter, state.branchFilterCursor)}${fetchTag}`);

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

  const choices = getWorktreeChoices(branch);

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

export function getWorktreeChoices(branch: WizardBranch): Array<{ label: string; hint: string }> {
  const checkoutHint = branch.isRemote
    ? `create local ${branch.name} tracking origin`
    : `checkout ${branch.name}`;
  return [
    { label: "New worktree + new branch", hint: `new branch off ${branch.name}` },
    { label: "New worktree on this branch", hint: `worktree on ${branch.name}, no fork` },
    { label: "Checkout in place", hint: checkoutHint },
  ];
}

function renderWorktreeStep(lines: string[], state: WizardState): void {
  const repo = state.selectedRepo!;
  const branch = state.selectedBranch!;
  const reuse = state.worktreeMode === "reuse";

  if (reuse) {
    // Reusing the selected branch: the branch is fixed, the text field edits the dir.
    lines.push(`  {${C.dim}-fg}Branch:{/${C.dim}-fg} {${C.fg}-fg}${branch.name}{/${C.fg}-fg} {${C.dim}-fg}(reused){/${C.dim}-fg}`);
    lines.push(`  {${C.muted}-fg}Directory name:{/${C.muted}-fg}`);
  } else {
    lines.push(`  {${C.muted}-fg}New branch name:{/${C.muted}-fg}`);
  }
  lines.push("");
  lines.push(`{${C.surface}-bg}  {${C.peach}-fg}>{/${C.peach}-fg} ${renderTextWithCursor(state.worktreeName, state.worktreeNameCursor)}{/${C.surface}-bg}`);

  if (state.worktreeName) {
    const wtPath = worktreeDirName(repo.name, cleanBranchToDir(state.worktreeName));
    const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
    const command = reuse
      ? `git worktree add ${wtPath} ${branch.name}`
      : `git worktree add ${wtPath} -b ${state.worktreeName} ${baseRef}`;
    lines.push("");
    lines.push(`  {${C.dim}-fg}Path:{/${C.dim}-fg}    {${C.fg}-fg}${wtPath}{/${C.fg}-fg}`);
    lines.push(`  {${C.dim}-fg}Command:{/${C.dim}-fg} {${C.mint}-fg}${command}{/${C.mint}-fg}`);
  } else {
    lines.push("");
    lines.push(`  {${C.dim}-fg}${reuse ? "Type a directory name for the worktree" : "Type a branch name to create a worktree"}{/${C.dim}-fg}`);
  }
}

/**
 * Render contextual preview for wizard state.
 */
export async function renderWizardPreview(previewBox: Widgets.BoxElement, state: WizardState): Promise<void> {
  if (state.step === "repo") {
    const sel = state.filteredRepos[state.repoIndex];
    if (!sel) {
      previewBox.setContent(
        `\n{${C.muted}-fg}  Select a repo to start a new Claude session{/${C.muted}-fg}`,
      );
      return;
    }
    if (sel.isWorktree) {
      // Detached worktrees have no branch — label them by their directory name.
      const label = sel.currentBranch === "detached"
        ? `${sel.path.split("/").filter(Boolean).pop()} {${C.dim}-fg}(detached){/${C.dim}-fg}`
        : sel.currentBranch;
      previewBox.setContent(
        `{${C.muted}-fg}  Worktree{/${C.muted}-fg}\n\n` +
        `  {${C.dim}-fg}Branch:{/${C.dim}-fg} {${C.fg}-fg}${label}{/${C.fg}-fg}\n` +
        `  {${C.dim}-fg}Path:{/${C.dim}-fg}   {${C.fg}-fg}${abbreviatePath(sel.path)}{/${C.fg}-fg}\n\n` +
        `  {${C.dim}-fg}⏎ launches Claude here directly{/${C.dim}-fg}\n` +
        `  {${C.dim}-fg}^O opens a shell here (no Claude){/${C.dim}-fg}`,
      );
      return;
    }
    // Base repo: live info panel — last commit, worktree count, session state.
    const wtLine = sel.worktreeCount
      ? `  {${C.dim}-fg}Worktrees:{/${C.dim}-fg} {${C.fg}-fg}${sel.worktreeCount}{/${C.fg}-fg}\n`
      : "";
    const sessionLine = sel.hasSession
      ? `  {${C.dim}-fg}Session:{/${C.dim}-fg}   {${C.mint}-fg}active{/${C.mint}-fg}\n`
      : "";
    const log = await getBranchLog(sel.path, sel.currentBranch);
    const logBlock = log
      ? `\n{${C.muted}-fg}  Recent commits{/${C.muted}-fg}\n\n${ansiToBlessedMarkup(log)}`
      : `\n{${C.dim}-fg}  No log available{/${C.dim}-fg}`;
    previewBox.setContent(
      `{${C.muted}-fg}  ${sel.name}{/${C.muted}-fg}\n\n` +
      `  {${C.dim}-fg}Branch:{/${C.dim}-fg}    {${C.fg}-fg}${sel.currentBranch}{/${C.fg}-fg}\n` +
      `  {${C.dim}-fg}Path:{/${C.dim}-fg}      {${C.fg}-fg}${abbreviatePath(sel.path)}{/${C.fg}-fg}\n` +
      wtLine + sessionLine + logBlock,
    );
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
      // New worktree + new branch off the selected branch
      const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
      lines.push(
        "",
        `  {${C.dim}-fg}Will create a new worktree with a new branch off ${baseRef}{/${C.dim}-fg}`,
      );
    } else if (state.worktreeChoiceIndex === 1) {
      // New worktree reusing the selected branch (no new branch)
      lines.push(
        "",
        `  {${C.dim}-fg}Will create a worktree on ${branch.name} (no new branch){/${C.dim}-fg}`,
      );
    } else {
      // Checkout in place
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
      const wtPath = worktreeDirName(repo.name, cleanBranchToDir(state.worktreeName));
      if (state.worktreeMode === "reuse") {
        lines.push(
          `  {${C.dim}-fg}Branch:{/${C.dim}-fg} {${C.fg}-fg}${branch.name}{/${C.fg}-fg} {${C.dim}-fg}(reused){/${C.dim}-fg}`,
          `  {${C.dim}-fg}Dir:{/${C.dim}-fg}    {${C.fg}-fg}${wtPath}{/${C.fg}-fg}`,
          "",
          `  {${C.dim}-fg}Command:{/${C.dim}-fg}`,
          `  {${C.mint}-fg}git worktree add ${wtPath} ${branch.name}{/${C.mint}-fg}`,
        );
      } else {
        const baseRef = branch.isRemote ? `origin/${branch.name}` : branch.name;
        lines.push(
          `  {${C.dim}-fg}Branch:{/${C.dim}-fg} {${C.fg}-fg}${state.worktreeName}{/${C.fg}-fg}`,
          "",
          `  {${C.dim}-fg}Command:{/${C.dim}-fg}`,
          `  {${C.mint}-fg}git worktree add ${wtPath} -b ${state.worktreeName} ${baseRef}{/${C.mint}-fg}`,
        );
      }
    } else {
      lines.push(
        "",
        `  {${C.dim}-fg}${state.worktreeMode === "reuse" ? "Enter a directory name for the worktree" : "Enter a branch name for the worktree"}{/${C.dim}-fg}`,
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
  // ^O = launch without Claude; hinted only where \u23CE would launch.
  const shellHint = (label: string) => `  {${C.peach}-fg}^O{/${C.peach}-fg} {${C.dim}-fg}${label}{/${C.dim}-fg}`;

  if (state.step === "repo") {
    const onWorktree = state.filteredRepos[state.repoIndex]?.isWorktree;
    content =
      `{${C.peach}-fg}type{/${C.peach}-fg} {${C.dim}-fg}filter{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u2191/\u2193{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u2192{/${C.peach}-fg} {${C.dim}-fg}worktrees{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}select{/${C.dim}-fg}` +
      (onWorktree ? shellHint("shell only") : "") +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}cancel{/${C.dim}-fg}`;
  } else if (state.step === "branch") {
    content =
      `{${C.peach}-fg}↑/↓{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
      `  {${C.peach}-fg}type{/${C.peach}-fg} {${C.dim}-fg}to filter{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}select{/${C.dim}-fg}` +
      (state.filteredBranches[state.branchIndex]?.isCurrent ? shellHint("shell only") : "") +
      `  {${C.peach}-fg}^R{/${C.peach}-fg} {${C.dim}-fg}fetch{/${C.dim}-fg}` +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}back{/${C.dim}-fg}`;
  } else if (state.step === "worktree-choice") {
    content =
      `{${C.peach}-fg}j/k{/${C.peach}-fg} {${C.dim}-fg}move{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}select{/${C.dim}-fg}` +
      (state.worktreeChoiceIndex === 2 ? shellHint("shell only") : "") +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}back{/${C.dim}-fg}`;
  } else if (state.step === "worktree") {
    const label = state.worktreeMode === "reuse" ? "directory name" : "branch name";
    content =
      `{${C.peach}-fg}type{/${C.peach}-fg} {${C.dim}-fg}${label}{/${C.dim}-fg}` +
      `  {${C.peach}-fg}\u23CE{/${C.peach}-fg} {${C.dim}-fg}launch Claude{/${C.dim}-fg}` +
      shellHint("worktree only") +
      `  {${C.peach}-fg}Esc{/${C.peach}-fg} {${C.dim}-fg}back{/${C.dim}-fg}`;
  }

  statusBar.setContent(content);
}

/**
 * Pure state machine for wizard key handling. Returns a WizardAction.
 */
export function handleWizardKey(state: WizardState, keyName: string, ch: string): WizardAction {
  if (state.step === "repo") {
    return handleRepoKey(state, keyName, ch);
  } else if (state.step === "branch") {
    return handleBranchFilterKey(state, keyName, ch);
  } else if (state.step === "worktree-choice") {
    return handleWorktreeChoiceKey(state, keyName);
  } else if (state.step === "worktree") {
    return handleWorktreeKey(state, keyName, ch);
  }

  return { type: "noop" };
}

function handleRepoKey(state: WizardState, keyName: string, ch: string): WizardAction {
  // Step-specific keys first (nav + select + cancel). Plain letters fall
  // through to the filter, so movement uses arrows or ctrl+j/ctrl+k — note
  // blessed delivers ctrl+j as keyName "linefeed", not "C-j".
  switch (keyName) {
    case "down":
    case "linefeed": // ctrl+j
      if (state.filteredRepos.length > 0) {
        state.repoIndex = Math.min(state.repoIndex + 1, state.filteredRepos.length - 1);
        return { type: "preview" };
      }
      return { type: "noop" };
    case "up":
    case "C-k": // ctrl+k
      if (state.filteredRepos.length > 0) {
        state.repoIndex = Math.max(state.repoIndex - 1, 0);
        return { type: "preview" };
      }
      return { type: "noop" };
    case "tab": {
      // Toggle the highlighted base's worktrees inline (browse view only).
      if (state.repoFilter) return { type: "noop" };
      const sel = state.filteredRepos[state.repoIndex];
      if (sel && !sel.isWorktree && sel.worktreeCount) {
        setRepoExpanded(state, sel.path, !state.expandedRepos.includes(sel.path));
        return { type: "preview" };
      }
      return { type: "noop" };
    }
    case "right": {
      // Expand the highlighted base. When filtering, left/right move the text
      // cursor instead — fall through to the text-input handler below.
      if (state.repoFilter) break;
      const sel = state.filteredRepos[state.repoIndex];
      if (sel && !sel.isWorktree && sel.worktreeCount && !state.expandedRepos.includes(sel.path)) {
        setRepoExpanded(state, sel.path, true);
        return { type: "preview" };
      }
      return { type: "noop" };
    }
    case "left": {
      if (state.repoFilter) break; // text cursor while filtering
      const sel = state.filteredRepos[state.repoIndex];
      if (!sel) return { type: "noop" };
      if (sel.isWorktree) {
        // Collapse the parent base and land the cursor on it.
        let p = state.repoIndex;
        while (p > 0 && state.filteredRepos[p].isWorktree) p--;
        setRepoExpanded(state, state.filteredRepos[p].path, false);
        return { type: "preview" };
      }
      if (sel.worktreeCount && state.expandedRepos.includes(sel.path)) {
        setRepoExpanded(state, sel.path, false);
        return { type: "preview" };
      }
      return { type: "noop" };
    }
    case "enter":
    case "return":
    case "C-o": {
      if (state.filteredRepos.length === 0) return { type: "noop" };
      const sel = state.filteredRepos[state.repoIndex];
      if (sel.isWorktree) {
        // Existing worktree: launch there directly on its current branch —
        // with Claude (⏎), or as a plain shell (^O).
        state.selectedRepo = sel;
        const branch: WizardBranch = { name: sel.currentBranch, isRemote: false, isCurrent: true, fullRef: sel.currentBranch };
        state.selectedBranch = branch;
        return { type: "launch", repo: sel, branch, mode: "current", text: "", shellOnly: keyName === "C-o" };
      }
      if (keyName === "C-o") return { type: "noop" }; // ^O only launches; ⏎ advances
      state.selectedRepo = sel;
      state.step = "branch";
      state.branchIndex = 0;
      state.branchFilter = "";
      state.branchFilterCursor = 0;
      state.branchFilterActive = true;
      return { type: "loadBranches" };
    }
    case "escape":
      return { type: "cancel" };
  }

  // Centralized text input handling → updates the filter.
  const prevText = state.repoFilter;
  const prevCursor = state.repoFilterCursor;
  const result = handleTextInputKey(state.repoFilter, state.repoFilterCursor, keyName, ch);
  if (result.handled) {
    state.repoFilter = result.text;
    state.repoFilterCursor = result.cursor;
    if (result.text !== prevText) {
      applyRepoFilter(state);
    }
    if (result.text !== prevText || result.cursor !== prevCursor) {
      return { type: "preview" };
    }
    return { type: "noop" };
  }

  return { type: "noop" };
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
    case "C-k": // ctrl+k
      if (state.filteredBranches.length > 0) {
        state.branchIndex = Math.max(state.branchIndex - 1, 0);
        return { type: "preview" };
      }
      return { type: "noop" };
    case "down":
    case "linefeed": // ctrl+j (blessed remaps \n, so it's never "C-j")
      if (state.filteredBranches.length > 0) {
        state.branchIndex = Math.min(state.branchIndex + 1, state.filteredBranches.length - 1);
        return { type: "preview" };
      }
      return { type: "noop" };
    case "enter":
    case "return":
    case "C-o": {
      if (state.filteredBranches.length === 0) return { type: "noop" };
      const branch = state.filteredBranches[state.branchIndex];

      if (branch.isCurrent) {
        // Current branch: launch directly, no chooser needed. ^O skips Claude.
        state.selectedBranch = branch;
        return { type: "launch", repo: state.selectedRepo!, branch, mode: "current", text: "", shellOnly: keyName === "C-o" };
      }
      if (keyName === "C-o") return { type: "noop" }; // ^O only launches; ⏎ advances

      state.selectedBranch = branch;
      state.step = "worktree-choice";
      // Feature branch → default to "reuse" (option 1); trunk → "new branch" (option 0).
      state.worktreeChoiceIndex = isTrunk(branch, state.defaultBranch) ? 0 : 1;
      state.enterDebounceUntil = Date.now() + 100;
      return { type: "render" };
    }
    case "C-r":
      // Manual refresh: re-fetch remote branches on demand (fallback for a
      // branch a teammate pushed after the on-entry background fetch ran).
      if (state.fetchState === "fetching") return { type: "noop" };
      return { type: "fetch" };
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

/**
 * Replace the branch list (e.g. after a fetch) and re-apply the active filter,
 * preserving the typed query and clamping the selection.
 */
export function setWizardBranches(state: WizardState, branches: WizardBranch[]): void {
  state.branches = branches;
  applyBranchFilter(state);
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
      state.worktreeChoiceIndex = Math.min(state.worktreeChoiceIndex + 1, 2);
      return { type: "render" };
    case "k":
    case "up":
      state.worktreeChoiceIndex = Math.max(state.worktreeChoiceIndex - 1, 0);
      return { type: "render" };
    case "enter":
    case "return":
    case "C-o": {
      if (Date.now() < state.enterDebounceUntil) return { type: "noop" };
      const branch = state.selectedBranch!;
      const repo = state.selectedRepo!;

      if (state.worktreeChoiceIndex === 2) {
        // Checkout in place → launch directly (isCurrent can't reach here, but guard anyway)
        return { type: "launch", repo, branch, mode: branch.isCurrent ? "current" : "checkout", text: "", shellOnly: keyName === "C-o" };
      }
      if (keyName === "C-o") return { type: "noop" }; // ^O only launches; ⏎ advances

      // New worktree (new-branch or reuse) → advance to name input
      state.step = "worktree";
      if (state.worktreeChoiceIndex === 1) {
        // Reuse branch: text field edits the dir, prefilled with the cleaned branch name.
        state.worktreeMode = "reuse";
        const prefill = cleanBranchToDir(branch.name);
        state.worktreeName = prefill;
        state.worktreeNameCursor = prefill.length;
      } else {
        // New branch: text field edits the new branch name; blank for remote, branch name for local.
        state.worktreeMode = "new-branch";
        const prefill = branch.isRemote ? "" : branch.name;
        state.worktreeName = prefill;
        state.worktreeNameCursor = prefill.length;
      }
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
    case "return":
    case "C-o": {
      if (Date.now() < state.enterDebounceUntil) return { type: "noop" };
      if (!state.worktreeName.trim()) return { type: "noop" };
      const repo = state.selectedRepo!;
      const branch = state.selectedBranch!;
      return { type: "launch", repo, branch, mode: state.worktreeMode, text: state.worktreeName, shellOnly: keyName === "C-o" };
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
