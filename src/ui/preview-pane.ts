import { homedir } from "os";
import type { Widgets } from "blessed";
import type { Session } from "../types";

import { capturePane } from "../core/tmux";
import { getLastAssistantMessage } from "../core/sessions";

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

export async function updatePreview(
  box: Widgets.BoxElement,
  session: Session | null,
): Promise<void> {
  if (session === null) {
    box.setContent("");
    return;
  }

  const header = `{#A0A0A0-fg}  ${session.repo}/${session.branch}{/#A0A0A0-fg}`;
  let body = "";

  if (session.tmuxPane) {
    // Live session — capture pane output
    const captured = await capturePane(session.tmuxPane.paneId);
    // Escape curly braces so blessed doesn't interpret them as tag markup
    body = captured.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
  } else {
    // Idle session — show last assistant message
    const encodedPath = encodeProjectPath(session.repoPath);
    const sessionPath = `${homedir()}/.claude/projects/${encodedPath}/${session.id}.jsonl`;
    const lastMessage = await getLastAssistantMessage(sessionPath);

    if (lastMessage) {
      const escaped = lastMessage.replace(/\{/g, "{open}").replace(/\}/g, "{close}");
      body = `{#A0A0A0-fg}{italic}${escaped}{/italic}{/#A0A0A0-fg}`;
    } else {
      body = `{#505050-fg}No recent output{/#505050-fg}`;
    }
  }

  const content = `${header}\n${body}`;
  box.setContent(content);
}
