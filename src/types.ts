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
  branch: string;
  status: "running" | "waiting" | "ready" | "idle" | "archived";
  contextPercent: number;
  messageCount: number;
  summary: string;
  modified: Date;
  firstPrompt: string;
  name: string;
  tmuxPane?: TmuxPane;
  /** Cached pane capture from status detection — reused by preview to avoid a duplicate tmux call */
  lastCapture?: string;
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
  /** Enable tmux status bar widget (Tier 1) */
  statusWidget: boolean;
  /** Enable window name ⚡ prefix (Tier 2) */
  windowPrefix: boolean;
  /** Enable terminal bell (Tier 3) */
  bell: boolean;
  /** Which transitions trigger bell (Tier 3) */
  bellOn: "blocked" | "all";
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
