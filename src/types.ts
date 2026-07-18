export interface TmuxPane {
  paneId: string;
  windowIndex: number;
  sessionName: string;
  windowName: string;
}

export interface Session {
  id: string;
  repo: string;
  repoPath: string;
  baseRepoPath: string;
  branch: string;
  status: "running" | "waiting" | "ready" | "idle" | "archived";
  contextPercent: number;
  messageCount: number;
  summary: string;
  modified: Date;
  firstPrompt: string;
  /** Most recent user prompt from JSONL `last-prompt` entries — reflects current convo direction after /rewind */
  lastPrompt: string;
  name: string;
  tmuxPane?: TmuxPane;
  /** Cached pane capture from status detection — reused by preview to avoid a duplicate tmux call */
  lastCapture?: string;
  /** Where `status` came from: Claude's native status file › event-sourced hook log › viewport scraper. */
  statusSource?: "event" | "scraper" | "native";
}

export interface RepoGroup {
  name: string;
  path: string;
  sessions: Session[];
}

export interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  summary: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

export interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
}

export interface PaneInfo {
  tty: string;
  paneId: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  currentPath: string;
}

export interface ClaudeProcess {
  pid: number;
  tty: string;
  command: string;
  sessionId?: string;
  /** Launched with `--fork-session`. Its `sessionId` (when set) is the fork's REAL
   *  id read from Claude's per-pid native file, NOT the parent the hook records. */
  isFork: boolean;
}

export type DisplayRow =
  | { type: "repo-header"; name: string; path: string }
  | { type: "separator" }
  | { type: "session"; session: Session }
  | { type: "session-detail"; session: Session }
  | { type: "archive-collapsed"; repoName: string; count: number; sessions: Session[] };

// --- Notification system types ---

export interface NotificationConfig {
  /** Enable tmux status bar monitor (Tier 1) */
  statusMonitor: boolean;
  /** Enable window name ⚡ prefix (Tier 2) */
  windowPrefix: boolean;
  /** Enable macOS native notifications (Tier 3) */
  nativeNotification: boolean;
  /** ntfy.sh topic for phone push (Tier 4). Unset ⇒ push disabled. */
  ntfyTopic?: string;
  /** Explicit bridge origin for deep links; else auto-detected via `tailscale serve status`. */
  bridgeUrl?: string;
}

export interface SessionNotificationState {
  status: string;
  needsAttention: boolean;
  /** Classification of the transition that caused attention */
  attentionType?: "blocked" | "turnComplete";
  tmuxSession?: string;
  tmuxWindow?: number;
  tmuxPane?: string;
  windowName?: string;
  lastTransition?: number;
}

export interface CsmState {
  lastUpdatedBy: "tui" | "monitor" | "bridge";
  lastUpdatedAt: number;
  sessions: Record<string, SessionNotificationState>;
}

export interface AggregateStatus {
  needsAttention: number;
  running: number;
  waiting: number;
  ready: number;
}

export interface TransitionEvent {
  sessionKey: string;
  previousStatus: string;
  currentStatus: string;
  classification: "blocked" | "turnComplete" | "none";
  session: Session;
}

// --- New Session Wizard types ---

export interface WizardRepo {
  name: string;           // base repo name (last path component; worktrees inherit their base's name)
  path: string;           // absolute repo/worktree path
  currentBranch: string;  // checked-out branch
  isWorktree?: boolean;   // true = a linked worktree row nested under its base repo
  isLastWorktree?: boolean; // true = last worktree child of its base (tree connector)
  hasSession?: boolean;   // true = base repo has an active/recent session (sorts to top)
  worktreeCount?: number; // linked worktrees under this base (from git worktree list); drives the collapsed-row badge
}

export interface WizardBranch {
  name: string;        // local name (remotes/origin/ stripped)
  isRemote: boolean;   // remote-only branch
  isCurrent: boolean;  // repo's current branch
  fullRef: string;     // original ref
}

export type WizardStep = "repo" | "branch" | "worktree-choice" | "worktree";

/** How a launched session sets up its working tree. */
export type WorktreeMode = "new-branch" | "reuse" | "checkout" | "current";

export interface WizardState {
  step: WizardStep;
  repos: WizardRepo[];          // all rows (bases + nested worktrees) in discovery order
  filteredRepos: WizardRepo[];  // currently-visible rows the cursor indexes into: bases-only when repoFilter is empty, scored flat matches otherwise
  repoIndex: number;            // index into filteredRepos
  repoFilter: string;           // repo-step type-to-filter query
  repoFilterCursor: number;
  expandedRepos: string[];      // base repo paths whose worktrees are expanded inline (empty-filter browse view)
  selectedRepo: WizardRepo | null;
  branches: WizardBranch[];
  filteredBranches: WizardBranch[];
  branchIndex: number;
  branchFilter: string;
  branchFilterCursor: number;
  branchFilterActive: boolean;
  selectedBranch: WizardBranch | null;
  defaultBranch: string;       // repo trunk (from origin/HEAD); drives the worktree-choice default cursor
  worktreeChoiceIndex: number; // 0 = new worktree + new branch, 1 = new worktree (reuse branch), 2 = checkout
  worktreeMode: "new-branch" | "reuse"; // what the worktree step's text field edits: a new branch name, or a dir name
  worktreeName: string;        // text input: new branch name (new-branch) or dir name (reuse)
  worktreeNameCursor: number;
  enterDebounceUntil: number;  // timestamp (ms) — ignore Enter until this time (prevents double-fire on step transition)
  fetchState: "idle" | "fetching" | "done"; // background `git fetch` status for the branch step
}

export type WizardAction =
  | { type: "noop" }
  | { type: "render" }
  | { type: "preview" }
  | { type: "cancel" }
  | { type: "loadBranches" }
  | { type: "fetch" }
  | { type: "launch"; repo: WizardRepo; branch: WizardBranch; mode: WorktreeMode; text: string };

// --- Global search types ---

export interface GlobalSearchState {
  query: string;
  cursor: number;
  entries: SearchEntryRef[];  // all loaded entries (cached for search session)
  results: SearchEntryRef[];  // filtered/ranked subset (max 50)
  selectedIndex: number;
  loading: boolean;
}

// Forward ref — actual type lives in core/search.ts to avoid circular deps
export type SearchEntryRef = import("./core/search").SearchEntry;

export interface CsmConfig {
  statusMonitor: boolean;
  windowPrefix: boolean;
  nativeNotification: boolean;
  repoPaths?: string[];       // dirs to scan 1-level deep for git repos
  priorityRepos?: string[];   // repo names pinned at top of list (lowercase)
  ntfyTopic?: string;         // ntfy.sh topic for phone push (Tier 4); unset ⇒ disabled
  bridgeUrl?: string;         // explicit bridge origin for deep links; else auto-detected
}

// --- Hook event log + transcript types (Impl #2 — Camp 1) ---

/**
 * Raw Claude Code hook payload, verbatim (snake_case). One JSON object per line
 * in `events/<session_id>.jsonl`. `event-status.test.ts` casts the committed
 * fixtures (`hooks/*.json`) `as HookEvent` and feeds them straight to
 * `deriveStatus`, so this IS the on-disk shape — no normalization layer.
 * Re-exported from `core/event-status.ts` to satisfy the test import path.
 * Unknown keys are tolerated (forward-compat across claude versions).
 */
export interface HookEvent {
  session_id: string;
  hook_event_name:
    | "SessionStart"
    | "UserPromptSubmit"
    | "PreToolUse"
    | "PostToolUse"
    | "Notification"
    | "Stop"
    | "SubagentStop";
  transcript_path: string; // absolute path to the JSONL transcript (free on every event)
  cwd: string;
  permission_mode?: string;
  effort?: { level: string };
  tool_name?: string; // PreToolUse / PostToolUse
  tool_input?: unknown; // PreToolUse (AskUserQuestion → { questions: [...] })
  tool_use_id?: string;
  notification_type?: "permission_prompt" | "idle_prompt";
  message?: string; // Notification
  prompt?: string; // UserPromptSubmit — the submitted prompt text
  prompt_id?: string; // UserPromptSubmit — unique per-turn identity
}

/**
 * A single block inside a transcript turn's `message.content[]`. Re-exported from
 * `core/transcript.ts` (the test imports it from "./transcript").
 */
export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean }
  // Byte-free marker only: the source's base64 image data is dropped at parse time so it
  // never bloats the transcript payload — the UI just shows a "🖼 image" chip.
  | { type: "image" };

/**
 * One conversational turn. Field is `content` (NOT `blocks`) — the contract test
 * requires `t.content`. A string-valued `message.content` becomes one text block.
 */
export interface TranscriptTurn {
  role: "user" | "assistant";
  content: TranscriptBlock[];
  // Set on the post-compaction summary record (`isCompactSummary` in the JSONL). Claude
  // Code writes the summary as a `user` turn whose content is the whole summary; this flag
  // lets the UI render it as a "continued from compacted summary" divider instead of a giant
  // user bubble, making it clear the branch originated from a compact.
  compactSummary?: boolean;
}

/** A tool awaiting approval, surfaced from the blocking PreToolUse hook (Inc6). */
export interface PendingApproval {
  sessionId: string;
  ts: number;
  tool: string;
  tool_use_id: string;
  input: unknown;
  /** Absent ⇒ approval (back-compat with in-flight files). "question" records are a
   * held AskUserQuestion intercept and are filtered out of the approvals list. */
  kind?: "approval" | "question";
}
