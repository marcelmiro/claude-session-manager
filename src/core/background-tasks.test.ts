import { describe, expect, test } from "bun:test";
import { parseBackgroundTasks, pendingScripts } from "./background-tasks";

const line = (o: unknown) => JSON.stringify(o);

function bashLaunch(id: string, taskId: string | null, cmd = "sleep 99", ts = "2026-07-21T00:00:00Z") {
  const use = line({
    type: "assistant",
    timestamp: ts,
    message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd, run_in_background: true } }] },
  });
  const resultText = taskId
    ? `Command running in background with ID: ${taskId}. Output is being written to: /tmp/x.output.`
    : "Permission for this action was denied by the auto mode classifier.";
  const result = line({
    type: "user",
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content: resultText }] },
  });
  return [use, result];
}

const notif = (taskId: string, toolUseId: string, status = "completed") =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`;

describe("parseBackgroundTasks", () => {
  test("bash launch without notification is a pending script", () => {
    const tasks = parseBackgroundTasks(bashLaunch("toolu_1", "babc123").join("\n"));
    expect(tasks).toEqual([
      {
        toolUseId: "toolu_1",
        kind: "script",
        label: "sleep 99",
        status: "pending",
        taskId: "babc123",
        launchedAt: "2026-07-21T00:00:00Z",
      },
    ]);
  });

  test("user-message notification completes the task", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "babc123"),
      line({ type: "user", message: { content: notif("babc123", "toolu_1") } }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)[0]!.status).toBe("completed");
  });

  test("queue-operation carrier (root-level content) pairs by task-id", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "babc123"),
      line({ type: "queue-operation", operation: "enqueue", content: notif("babc123", "toolu_1") }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)[0]!.status).toBe("completed");
  });

  test("queued_command attachment carrier pairs, and killed status sticks", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "babc123"),
      line({
        type: "attachment",
        attachment: { type: "queued_command", prompt: notif("babc123", "toolu_1", "killed") },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)[0]!.status).toBe("killed");
  });

  test("denied bash launch (no task created) yields no task", () => {
    expect(parseBackgroundTasks(bashLaunch("toolu_1", null).join("\n"))).toEqual([]);
  });

  test("foreground bash whose OUTPUT quotes launch text yields no task", () => {
    const jsonl = [
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "grep bg *.jsonl" } }] },
      }),
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "Command running in background with ID: bzzz." },
          ],
        },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  test("synchronous Agent call (result is the report, no async confirmation) yields no task", () => {
    const jsonl = [
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Blind plan review", prompt: "…" } },
          ],
        },
      }),
      line({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Here is my review: fine." }] },
      }),
    ].join("\n");
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  test("async Agent launch (flag absent — background by default) pairs via agentId", () => {
    const jsonl = [
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input: { description: "Research X", prompt: "…" } }],
        },
      }),
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "Async agent launched successfully.\nagentId: a1b2c3d4e5f6a7b8c (internal)",
            },
          ],
        },
      }),
      line({ type: "user", message: { content: notif("a1b2c3d4e5f6a7b8c", "toolu_1") } }),
    ].join("\n");
    const tasks = parseBackgroundTasks(jsonl);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.kind).toBe("agent");
    expect(tasks[0]!.status).toBe("completed");
  });

  test("unmatched notification (nested agent / pre-split launch) is ignored", () => {
    const jsonl = line({ type: "user", message: { content: notif("astray1", "toolu_gone") } });
    expect(parseBackgroundTasks(jsonl)).toEqual([]);
  });

  test("torn lines and empty input never throw", () => {
    expect(parseBackgroundTasks("")).toEqual([]);
    expect(parseBackgroundTasks('{"type":"assistant","message":{"content":[{"type":"tool_use","run_in_background')).toEqual([]);
  });
});

describe("pendingScripts", () => {
  test("keeps pending scripts only — agents and completed scripts excluded", () => {
    const jsonl = [
      ...bashLaunch("toolu_1", "bdone1"),
      line({ type: "user", message: { content: notif("bdone1", "toolu_1") } }),
      ...bashLaunch("toolu_2", "bwait2", "gh pr checks --watch"),
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_3", name: "Agent", input: { description: "bg agent" } }] },
      }),
      line({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_3", content: "Async agent launched successfully. agentId: abc123abc123abc12" },
          ],
        },
      }),
    ].join("\n");
    const pending = pendingScripts(parseBackgroundTasks(jsonl));
    expect(pending).toHaveLength(1);
    expect(pending[0]!.taskId).toBe("bwait2");
    expect(pending[0]!.label).toBe("gh pr checks --watch");
  });
});
