import type { Widgets } from "blessed";
import { C } from "./colors";
import type { SessionStatus } from "../core/status";
import type { PendingToolCall } from "../core/jsonl-reader";

function kl(key: string, label: string): string {
  return `{${C.peach}-fg}${key}{/${C.peach}-fg} {${C.dim}-fg}${label}{/${C.dim}-fg}`;
}

export function renderStatusBar(
  box: Widgets.BoxElement,
  enterAction?: SessionStatus,
  showArchived = false,
  pendingToolCall?: PendingToolCall | null,
): void {
  // Contextual approve/answer hints for waiting sessions
  if (pendingToolCall) {
    const common = `${kl("j/k", "move")}  ${kl("\u23CE", "switch")}  ${kl("Space", "more")}  ${kl("q", "quit")}`;
    if (pendingToolCall.question) {
      const n = pendingToolCall.question.options.length;
      box.setContent(`${kl(`1-${n}`, "answer")}  ${kl("t", "custom")}  │  ${common}`);
    } else {
      box.setContent(`${kl("y", "approve")}  ${kl("Y", "always")}  │  ${common}`);
    }
    return;
  }

  const enterLabel = enterAction === "archived" ? "resume" : "switch";
  const archiveLabel = showArchived ? "hide archived" : "show archived";
  const content =
    `${kl("j/k", "move")}` +
    `  ${kl("\u23CE", enterLabel)}` +
    `  ${kl("/", "search")}` +
    `  ${kl("Space", "actions")}` +
    `  ${kl("x", "kill")}` +
    `  ${kl("f", "fork")}` +
    `  ${kl("u/d", "scroll")}` +
    `  ${kl("n", "new")}` +
    `  ${kl("a", archiveLabel)}` +
    `  ${kl("q", "quit")}`;
  box.setContent(content);
}
