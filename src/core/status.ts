/**
 * Detects the status of a Claude Code session from captured tmux pane output.
 */

export type SessionStatus = "running" | "waiting" | "ready" | "idle" | "archived";

export interface StatusResult {
  status: SessionStatus;
  contextPercent?: number;
}

const RUNNING_PATTERNS = [
  /^ *[·✢✳✶∗✻✽] .*…/m,             // Spinner char + active verb with ellipsis (e.g. "✳ Adding…")
  /^ *·\s*$/m,                     // Standalone middle dot (initial thinking state, no text yet)
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,               // Legacy braille spinner characters
];

const WAITING_PATTERNS = [
  /Do you want to /i,            // Tool confirmation prompts (proceed, make this edit, etc.)
  /Claude wants to/,            // Tool use confirmation
  /Allow\s+Deny/,               // Permission buttons
  /Always allow/,               // Permission option
  /\(y\/n\)/i,                  // "(y/n)" confirmation
  /\[Y\/n\]/,                   // "[Y/n]" confirmation
  /\[y\/N\]/,                   // "[y/N]" confirmation
  /Would you like to proceed/i,  // Plan mode approval prompt
];

// Patterns for AskUserQuestion UI — appears below the prompt at the bottom of the screen
const QUESTION_UI_PATTERNS = [
  /☐/,                           // Unchecked checkbox (AskUserQuestion options)
  /←.*[☐✔].*→/,                 // Navigation bar with checkbox/checkmark controls
];

const SEPARATOR_RE = /^[─━═─\-▪][─━═─\-\s▪]{3,}/;
const TIP_RE = /^⎿\s+Tip:/;  // UI tip lines shown during running — skip like separators
const TASK_RE = /^(?:⎿\s+)?[✔◼◻☐]\s/;  // Task list items (completed/in-progress/pending) — skip to reach spinner

/**
 * Extract content lines immediately above the ❯ prompt.
 * Claude Code TUI layout (bottom of screen):
 *   [content lines]         ← conversation/tool output
 *   [status line]           ← spinner or completion indicator
 *   ────────────────────    ← separator
 *   ❯ [user input]         ← prompt
 *   ────────────────────    ← separator
 *   stats line              ← context %, model, branch
 *   toolbar                 ← accept edits, etc.
 *
 * Returns { statusLine, nearbyLines } where:
 *   statusLine = the first non-empty, non-separator line above the prompt (spinner/completion)
 *   nearbyLines = up to 3 such lines (for multi-line waiting prompts)
 */
export function getAbovePrompt(lines: string[]): { statusLine: string; nearbyLines: string } {
  // Find the last ❯ line (current input prompt)
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("❯")) {
      promptIdx = i;
      break;
    }
  }
  if (promptIdx === -1) return { statusLine: "", nearbyLines: "" };

  // Collect non-empty, non-separator lines above the prompt
  const above: string[] = [];
  for (let i = promptIdx - 1; i >= Math.max(0, promptIdx - 20); i--) {
    const trimmed = lines[i].trim();
    if (!trimmed || SEPARATOR_RE.test(trimmed) || TASK_RE.test(trimmed)) continue;
    if (TIP_RE.test(trimmed)) {
      // Tip line found — discard any continuation lines we already collected
      // (in narrow panes, tips wrap and continuations appear between tip header and separator)
      above.length = 0;
      continue;
    }
    above.push(trimmed);
    if (above.length >= 3) break;
  }
  return {
    statusLine: above[0] ?? "",
    nearbyLines: above.join("\n"),
  };
}

export function detectStatus(
  capturedOutput: string,
  hasProcess: boolean,
): StatusResult {
  if (!hasProcess) {
    return { status: "idle" };
  }

  const lines = capturedOutput.split("\n");
  const contextPercent = parseContextPercent(capturedOutput);
  const { statusLine, nearbyLines } = getAbovePrompt(lines);

  // 1. Waiting: permission/confirmation prompts take priority over running
  //    (spinner chars can linger in pane output while a prompt is displayed)
  for (const pattern of WAITING_PATTERNS) {
    if (pattern.test(nearbyLines)) {
      return { status: "waiting", contextPercent };
    }
  }

  // 2. Waiting: AskUserQuestion UI appears below the prompt at the bottom of screen
  const bottomLines = lines.slice(-15).join("\n");
  for (const pattern of QUESTION_UI_PATTERNS) {
    if (pattern.test(bottomLines)) {
      return { status: "waiting", contextPercent };
    }
  }

  // 3. Running: spinner on the status line (first line above prompt separator).
  //    Only check statusLine — old spinner text (e.g. "✻ Optimus Priming…") lingers
  //    in nearbyLines/scrollback after Claude finishes, causing false positives.
  for (const pattern of RUNNING_PATTERNS) {
    if (pattern.test(statusLine)) {
      return { status: "running", contextPercent };
    }
  }

  // 4. Ready: has a process but no spinner or prompt detected
  return { status: "ready", contextPercent };
}

function parseContextPercent(capturedOutput: string): number | undefined {
  const ctxMatch = capturedOutput.match(/(\d+(?:\.\d+)?k?)\/(\d+(?:\.\d+)?k?)\s*\((\d+)%\)/);
  if (ctxMatch) {
    return parseInt(ctxMatch[3], 10);
  }
  return undefined;
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
