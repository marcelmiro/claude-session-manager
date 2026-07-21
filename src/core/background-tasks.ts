/**
 * Background tasks a session launched and may still be waiting on — recovered
 * purely from the session's transcript JSONL by pairing task launches against
 * `<task-notification>` records. This is what lets the phone show "waiting on
 * script" for a session that reads `ready` (the turn genuinely ends while a
 * `run_in_background` command runs; skills like pr-triage wait this way for
 * tens of minutes).
 *
 * Detection rules (each validated against the full transcript history on disk):
 * - A candidate is a `tool_use` that runs in the background: Bash with
 *   `run_in_background: true`, any `Workflow` call, or any `Agent` call
 *   (background is the Agent tool's default and the key is often absent).
 * - The paired `tool_result` must CONFIRM a task was created — "Command running
 *   in background with ID: <id>" for Bash, "Async agent launched successfully…
 *   agentId: <id>" for Agent. Without it no notification will ever come: an
 *   Agent result without the confirmation ran synchronously (the result is its
 *   final report), and a Bash launch without it was denied or failed to start.
 *   Gating on the result of a known background tool_use also means a foreground
 *   command that merely PRINTS launch-shaped text can't false-positive.
 * - The completion arrives as a `<task-notification>` payload in one of three
 *   carriers: a `user` message (session was idle), or a `queue-operation` /
 *   queued_command `attachment` record (session was mid-turn). Paired by
 *   task-id or tool-use-id; unmatched notifications (nested-agent completions
 *   routed to the parent, launches on the far side of a /clear split) are ignored.
 */

export type BackgroundTaskKind = "script" | "agent" | "workflow";
export type BackgroundTaskStatus = "pending" | "completed" | "killed";

export interface BackgroundTask {
  /** Harness task id (`b7cxqdaxr` for Bash, hex agentId for Agent); Workflow launches may lack one. */
  taskId?: string;
  toolUseId: string;
  kind: BackgroundTaskKind;
  /** Bash command / Agent description, capped for display. */
  label: string;
  status: BackgroundTaskStatus;
  launchedAt?: string;
}

const LABEL_CAP = 160;
const BASH_LAUNCH_RE = /Command running in background with ID: (\S+?)\./;
const AGENT_LAUNCH_RE = /Async agent launched successfully[\s\S]*?agentId: (\w+)/;
const NOTIF_TASK_ID_RE = /<task-id>(\S+?)<\/task-id>/;
const NOTIF_TOOL_USE_RE = /<tool-use-id>(\S+?)<\/tool-use-id>/;
const NOTIF_STATUS_RE = /<status>(\w+)<\/status>/;

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text ?? "") : ""))
    .join("\n");
}

/** Parse one transcript's background tasks, launch-order preserved. Never throws. */
export function parseBackgroundTasks(jsonl: string): BackgroundTask[] {
  const byToolUse = new Map<string, BackgroundTask>();
  const byTaskId = new Map<string, BackgroundTask>();
  // Background tool_uses awaiting their tool_result, so the launch can be confirmed
  // and labelled. Also drives the line prefilter (a result line carries its use's id).
  const candidates = new Map<string, { name: string; label: string }>();

  for (const line of jsonl.split("\n")) {
    // Cheap prefilter — a launch's tool_result may not contain any fixed marker
    // text, so lines carrying a known candidate tool_use id also pass.
    if (
      !line.includes("run_in_background") &&
      !line.includes("task-notification") &&
      !line.includes('"name":"Workflow"') &&
      !line.includes('"name":"Agent"')
    ) {
      let carries = false;
      for (const id of candidates.keys()) {
        if (line.includes(id)) {
          carries = true;
          break;
        }
      }
      if (!carries) continue;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // torn/partial line
    }
    const content = (rec["message"] as { content?: unknown } | undefined)?.content;
    const ts = typeof rec["timestamp"] === "string" ? (rec["timestamp"] as string) : undefined;

    if (Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block["type"] === "tool_use") {
          const name = String(block["name"] ?? "");
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          const isCandidate =
            input["run_in_background"] === true ||
            name === "Workflow" ||
            (name === "Agent" && input["run_in_background"] !== false);
          if (!isCandidate) continue;
          candidates.set(String(block["id"]), {
            name,
            label: String(input["command"] ?? input["description"] ?? name).slice(0, LABEL_CAP),
          });
        } else if (block["type"] === "tool_result") {
          const toolUseId = String(block["tool_use_id"] ?? "");
          const use = candidates.get(toolUseId);
          if (!use) continue;
          candidates.delete(toolUseId);
          const text = blockText(block["content"]);
          const bash = text.match(BASH_LAUNCH_RE);
          const agent = text.match(AGENT_LAUNCH_RE);
          if (use.name === "Bash" && !bash) continue; // denied / failed to start
          if (use.name === "Agent" && !agent) continue; // ran synchronously
          const task: BackgroundTask = {
            toolUseId,
            kind: use.name === "Bash" ? "script" : use.name === "Agent" ? "agent" : "workflow",
            label: use.label,
            status: "pending",
          };
          const taskId = bash?.[1] ?? agent?.[1];
          if (taskId) {
            task.taskId = taskId;
            byTaskId.set(taskId, task);
          }
          if (ts) task.launchedAt = ts;
          byToolUse.set(toolUseId, task);
        }
      }
    }

    const attachment = rec["attachment"] as { prompt?: unknown } | undefined;
    const notifText =
      blockText(content) +
      (typeof rec["content"] === "string" ? (rec["content"] as string) : "") +
      (typeof attachment?.prompt === "string" ? attachment.prompt : "");
    if (notifText.includes("<task-notification>")) {
      const taskId = notifText.match(NOTIF_TASK_ID_RE)?.[1];
      const toolUseId = notifText.match(NOTIF_TOOL_USE_RE)?.[1];
      const task = (taskId && byTaskId.get(taskId)) || (toolUseId && byToolUse.get(toolUseId)) || undefined;
      if (task) task.status = notifText.match(NOTIF_STATUS_RE)?.[1] === "killed" ? "killed" : "completed";
    }
  }

  return [...byToolUse.values()];
}

/**
 * The scripts a session is waiting on right now — what the phone renders.
 * Agents/workflows are excluded: running subagents are already surfaced from the
 * `subagents/` directory, and a workflow's child agents appear there too.
 */
export function pendingScripts(tasks: BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((t) => t.kind === "script" && t.status === "pending");
}
