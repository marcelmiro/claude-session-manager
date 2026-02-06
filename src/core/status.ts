/**
 * Detects the status of a Claude Code session from captured tmux pane output.
 */

export type SessionStatus = "input" | "running" | "idle";

const PROMPT_PATTERNS = [/❯/, />\s*$/, /\$\s*$/];

const RUNNING_PATTERNS = [
  /Thinking/,
  /Reading/,
  /Writing/,
  /Searching/,
  /Running/,
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // spinner characters
];

export function detectStatus(
  capturedOutput: string,
  hasProcess: boolean,
): SessionStatus {
  if (!hasProcess) {
    return "idle";
  }

  const lines = capturedOutput.split("\n").filter((line) => line.trim() !== "");
  const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";

  // Check if the last non-empty line matches a prompt pattern
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(lastLine)) {
      return "input";
    }
  }

  // Check the last few lines for running indicators
  const recentLines = lines.slice(-10).join("\n");
  for (const pattern of RUNNING_PATTERNS) {
    if (pattern.test(recentLines)) {
      return "running";
    }
  }

  // Process exists but no running indicators — most likely at prompt
  return "input";
}

/**
 * Estimates context usage as a percentage.
 * Assumes ~800 tokens per message against a 200k context window.
 */
export function estimateContextPercent(messageCount: number): number {
  return Math.min(100, Math.round(((messageCount * 800) / 200000) * 100));
}

/**
 * Formats a date as relative time ago.
 * Returns: "now" (< 1 min), "Xm" (minutes), "Xh" (hours), "Xd" (days).
 */
export function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 60) {
    return "now";
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}
