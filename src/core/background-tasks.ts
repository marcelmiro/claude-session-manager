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
  /** The task's output file (from the Bash launch confirmation) — the liveness probe target. */
  outputPath?: string;
}

const LABEL_CAP = 160;
const BASH_LAUNCH_RE = /Command running in background with ID: (\S+?)\./;
const OUTPUT_PATH_RE = /Output is being written to: (\S+)/;
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
          // Description first: it's the model's own human label ("Background wait for
          // Codex review"), far more readable on a phone than the shell loop it runs.
          candidates.set(String(block["id"]), {
            name,
            label: String(input["description"] ?? input["command"] ?? name).slice(0, LABEL_CAP),
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
          // Strip the sentence's trailing period — the path itself ends in ".output".
          const outputPath = text.match(OUTPUT_PATH_RE)?.[1]?.replace(/\.$/, "");
          if (outputPath) task.outputPath = outputPath;
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
 * The scripts a session is waiting on per the TRANSCRIPT — launched, no notification
 * yet. Agents/workflows are excluded: running subagents are already surfaced from the
 * `subagents/` directory, and a workflow's child agents appear there too. Callers that
 * render should use `liveScripts` — the transcript can lie (an orphaned task's
 * notification never arrives); the runner-liveness probe is what makes it honest.
 */
export function pendingScripts(tasks: BackgroundTask[]): BackgroundTask[] {
  return tasks.filter((t) => t.kind === "script" && t.status === "pending");
}

// Liveness verdicts by taskId. Death is terminal — a runner never revives, so a dead
// verdict is cached forever and costs no further probes. An alive verdict re-probes
// after a short TTL to notice the runner exiting.
const runnerVerdicts = new Map<string, { ts: number; alive: boolean }>();
const ALIVE_TTL_MS = 15_000;

/**
 * Whether anything still runs a task: the runner holds an open fd on its output file
 * for its whole life, so `lsof` on that path is a definitive orphan test. A session
 * resumed under a new Claude process orphans its tasks — the transcript then says
 * "pending" forever (seen in real data: a 3-day-old wait on a live pane), and this
 * probe is what catches it. A missing output file (tmp pruned, reboot) reads dead too.
 */
export async function runnerAlive(outputPath: string): Promise<boolean> {
  try {
    // Absolute path: the monitor runs under tmux's status-command environment,
    // whose PATH lacks /usr/sbin — a bare "lsof" throws ENOENT there, which the
    // catch below would misreport as a dead runner.
    const proc = Bun.spawn(["/usr/sbin/lsof", "-t", outputPath], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false; // lsof unavailable/failed — treat as dead rather than badge forever
  }
}

/**
 * `pendingScripts` filtered to tasks whose runner is actually alive — what every
 * rendering surface uses. A task without an outputPath can't be probed and stays
 * visible. Note the flip side of trusting the probe: an intentionally-infinite
 * background daemon shows for as long as it truly runs — a true statement.
 */
export async function liveScripts(
  tasks: BackgroundTask[],
  probe: (outputPath: string) => Promise<boolean> = runnerAlive,
): Promise<BackgroundTask[]> {
  const out: BackgroundTask[] = [];
  for (const t of pendingScripts(tasks)) {
    if (!t.outputPath) {
      out.push(t);
      continue;
    }
    const key = t.taskId ?? t.toolUseId;
    const hit = runnerVerdicts.get(key);
    let alive: boolean;
    if (hit && (!hit.alive || Date.now() - hit.ts < ALIVE_TTL_MS)) alive = hit.alive;
    else {
      alive = await probe(t.outputPath);
      runnerVerdicts.set(key, { ts: Date.now(), alive });
    }
    if (alive) out.push(t);
  }
  return out;
}

// Per-transcript cache keyed by (size, mtime) — launch and notification are both
// transcript records, so an unchanged file means an unchanged answer. Shared by the
// detail view and the sessions-list badge, so a change costs one scan total. Caches the
// RAW tasks, not the filtered view: the liveness probe must run per read — a runner
// can die while the file (and thus this cache entry) sits still.
const pathCache = new Map<string, { size: number; mtimeMs: number; tasks: BackgroundTask[] }>();

/** Cached live pending scripts for a transcript file (runner-probed). [] on unreadable. */
export async function pendingScriptsAt(path: string): Promise<BackgroundTask[]> {
  try {
    const file = Bun.file(path);
    const stat = await file.stat();
    if (!stat) return [];
    const hit = pathCache.get(path);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return liveScripts(hit.tasks);
    const tasks = parseBackgroundTasks(await file.text());
    pathCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, tasks });
    return liveScripts(tasks);
  } catch {
    return [];
  }
}
