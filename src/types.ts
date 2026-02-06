export interface TmuxPane {
  paneId: string;
  windowIndex: number;
  sessionName: string;
}

export interface Session {
  id: string;
  repo: string;
  repoPath: string;
  branch: string;
  status: "input" | "running" | "idle";
  contextPercent: number;
  linesModified: number;
  messageCount: number;
  summary: string;
  modified: Date;
  tmuxPane?: TmuxPane;
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
  currentPath: string;
}

export interface ClaudeProcess {
  pid: number;
  tty: string;
  command: string;
}

export type DisplayRow =
  | { type: "repo-header"; name: string; path: string }
  | { type: "separator" }
  | { type: "session"; session: Session };
