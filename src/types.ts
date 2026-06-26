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
  /** Where `status` came from: event-sourced hook log vs viewport scraper (Inc4). */
  statusSource?: "event" | "scraper";
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
  lastUpdatedBy: "tui" | "monitor";
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
  name: string;           // last path component
  path: string;           // absolute repo path
  currentBranch: string;  // checked-out branch
}

export interface WizardBranch {
  name: string;        // local name (remotes/origin/ stripped)
  isRemote: boolean;   // remote-only branch
  isCurrent: boolean;  // repo's current branch
  fullRef: string;     // original ref
}

export type WizardStep = "repo" | "branch" | "worktree-choice" | "worktree";

export interface WizardState {
  step: WizardStep;
  repos: WizardRepo[];
  repoIndex: number;
  selectedRepo: WizardRepo | null;
  branches: WizardBranch[];
  filteredBranches: WizardBranch[];
  branchIndex: number;
  branchFilter: string;
  branchFilterCursor: number;
  branchFilterActive: boolean;
  selectedBranch: WizardBranch | null;
  worktreeChoiceIndex: number; // 0 = switch/checkout, 1 = new worktree
  worktreeName: string;        // text input: new branch name for worktree (empty = no worktree)
  worktreeNameCursor: number;
  enterDebounceUntil: number;  // timestamp (ms) — ignore Enter until this time (prevents double-fire on step transition)
}

export type WizardAction =
  | { type: "noop" }
  | { type: "render" }
  | { type: "preview" }
  | { type: "cancel" }
  | { type: "quit" }
  | { type: "loadBranches" }
  | { type: "launch"; repo: WizardRepo; branch: WizardBranch; worktreeName: string };

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
}

/**
 * A single block inside a transcript turn's `message.content[]`. Re-exported from
 * `core/transcript.ts` (the test imports it from "./transcript").
 */
export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

/**
 * One conversational turn. Field is `content` (NOT `blocks`) — the contract test
 * requires `t.content`. A string-valued `message.content` becomes one text block.
 */
export interface TranscriptTurn {
  role: "user" | "assistant";
  content: TranscriptBlock[];
}

/** A tool awaiting approval, surfaced from the blocking PreToolUse hook (Inc6). */
export interface PendingApproval {
  sessionId: string;
  ts: number;
  tool: string;
  tool_use_id: string;
  input: unknown;
}
