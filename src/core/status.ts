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
const TASK_SUMMARY_RE = /^…\s+\+\d+/;  // Collapsed task summary (e.g. "… +6 completed") — skip to reach spinner

/**
 * Extract content lines immediately above the ❯ prompt.
 * Claude Code TUI layout (bottom of screen):
 *   [content lines]         ← conversation/tool output
 *   [status line]           ← spinner or completion indicator
 *   [queued message UI]     ← optional, when user types while Claude is running
 *   ────────────────────    ← separator
 *   ❯ [user input]         ← prompt
 *   ────────────────────    ← separator
 *   stats line              ← context %, model, branch
 *   toolbar                 ← accept edits, etc.
 *   [subagent list UI]      ← optional ❯ ◯-prefixed items shown on hover
 *
 * Returns { statusLine, nearbyLines } where:
 *   statusLine = the spinner line if found within range, else the first content line above the prompt
 *   nearbyLines = up to 3 such lines (for multi-line waiting prompts)
 */
export function getAbovePrompt(lines: string[]): { statusLine: string; nearbyLines: string } {
  // Find the real ❯ input prompt: a ❯ line whose preceding non-empty line is a separator.
  // This excludes subagent list items ("❯ ◯ .plan-reviewer") that appear below the prompt.
  let promptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("❯")) continue;
    let prev = -1;
    for (let j = i - 1; j >= 0 && j >= i - 3; j--) {
      if (lines[j].trim()) { prev = j; break; }
    }
    if (prev !== -1 && SEPARATOR_RE.test(lines[prev].trim())) {
      promptIdx = i;
      break;
    }
  }
  // Fallback: last ❯ (handles edge cases where the separator is missing or off-screen)
  if (promptIdx === -1) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes("❯")) { promptIdx = i; break; }
    }
  }
  if (promptIdx === -1) return { statusLine: "", nearbyLines: "" };

  // Collect non-empty, non-separator lines above the prompt.
  // Scan a wider window than `above.length >= 3` would normally allow, so we can
  // find a spinner sitting above a queued-message UI between it and the prompt.
  const above: string[] = [];
  let spinnerLine = "";
  for (let i = promptIdx - 1; i >= Math.max(0, promptIdx - 25); i--) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || SEPARATOR_RE.test(trimmed) || TASK_RE.test(trimmed) || TASK_SUMMARY_RE.test(trimmed)) continue;
    // Skip right-aligned decorative content (e.g. Mottlex companion art)
    const leadingSpaces = line.length - line.trimStart().length;
    if (leadingSpaces > line.length * 0.6 && trimmed.length < 30) continue;
    if (TIP_RE.test(trimmed)) {
      // Tip line found — discard any continuation lines we already collected
      // (in narrow panes, tips wrap and continuations appear between tip header and separator)
      above.length = 0;
      spinnerLine = "";
      continue;
    }
    if (!spinnerLine && RUNNING_PATTERNS.some(p => p.test(trimmed))) {
      // Spinner marks the bottom of the active region — older content above it
      // is pre-spinner history (past assistant messages, user answers, etc.) and
      // must not pollute nearbyLines, or stray "do you want to" text from
      // earlier in the conversation will falsely trigger the waiting check.
      spinnerLine = trimmed;
      above.push(trimmed);
      break;
    }
    above.push(trimmed);
    if (above.length >= 8) break;
  }
  return {
    statusLine: spinnerLine || above[0] || "",
    nearbyLines: above.slice(0, 3).join("\n"),
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
