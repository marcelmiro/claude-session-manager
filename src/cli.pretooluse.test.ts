/**
 * Integration coverage for the generated `pretooluse.sh` detached-approval branch,
 * exercising the real installed-shape script (written by `setup()`) against a
 * stubbed `tmux` on PATH. Not pure — spawns bash — but it's the only thing that
 * pins the ADR-3 fix: a DETACHED session must NOT block on calls Claude would
 * auto-approve (bypassPermissions, read-only tools), or autonomous/subagent-heavy
 * runs stall up to 600s per call. Tools that CAN prompt must still block-poll.
 *
 * `home` helper first — `setup()` writes the hook under the temp $HOME root.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { setup } from "./cli";

const hookPath = `${TEST_HOME}/.config/csm/hooks/pretooluse.sh`;
const stubBin = `${TEST_HOME}/stub-bin`;
const decisionsDir = `${TEST_HOME}/.config/csm/decisions`;
const pendingDir = `${TEST_HOME}/.config/csm/pending`;

beforeAll(async () => {
  // TEST_HOME persists between runs and `setup()` only rewrites a script when the
  // installed CSM_HOOK_VERSION is older — so without this the suite can assert against a
  // stale script from a previous run and miss an edit to the template.
  rmSync(hookPath, { force: true });
  await setup(); // writes the real pretooluse.sh under TEST_HOME/.config/csm/hooks

  // Stub `tmux` so the hook sees a detached session: a session name exists
  // (display-message) but no client is attached (list-clients prints nothing).
  rmSync(stubBin, { recursive: true, force: true });
  mkdirSync(stubBin, { recursive: true });
  writeFileSync(
    `${stubBin}/tmux`,
    `#!/bin/bash\ncase "$*" in\n  *display-message*) echo "fakesess" ;;\n  *list-clients*) : ;;\n  *) : ;;\nesac\n`,
  );
  chmodSync(`${stubBin}/tmux`, 0o755);
});

interface HookResult {
  exitCode: number;
  stdout: string;
  pendingWritten: boolean;
}

/** Run the generated hook with `payload` on stdin against the stubbed tmux. */
async function runHook(payload: object, opts: { timeoutMs?: number } = {}): Promise<HookResult> {
  const sessionId = (payload as any).session_id;
  rmSync(`${pendingDir}/${sessionId}.json`, { force: true });
  const proc = Bun.spawn(["bash", hookPath], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: TEST_HOME, PATH: `${stubBin}:${process.env.PATH}`, TMUX_PANE: "%1" },
  });

  // Block-polling tools never exit on their own here — kill after a beat and
  // treat "pending file written" as proof it entered the block branch.
  const timeoutMs = opts.timeoutMs ?? 0;
  let timer: Timer | undefined;
  if (timeoutMs > 0) timer = setTimeout(() => proc.kill(), timeoutMs);
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);

  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    pendingWritten: existsSync(`${pendingDir}/${sessionId}.json`),
  };
}

const base = (overrides: object) => ({
  session_id: "itest",
  hook_event_name: "PreToolUse",
  transcript_path: "/tmp/x",
  cwd: "/tmp",
  permission_mode: "default",
  tool_use_id: "toolu_itest",
  ...overrides,
});

test("detached + read-only tool (Read) exits neutral — no block, no pending", async () => {
  // timeoutMs guards regression: if the gate is removed, Read would block here —
  // the kill makes that a clean failure (non-zero exit + pending written) not a hang.
  const r = await runHook(base({ tool_name: "Read", tool_input: { file_path: "/etc/hosts" } }), { timeoutMs: 5000 });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.trim()).toBe(""); // neutral fall-through, no permissionDecision
  expect(r.pendingWritten).toBe(false);
});

test("detached + Task (subagent dispatch) exits neutral", async () => {
  const r = await runHook(base({ tool_name: "Task", session_id: "itest-task" }), { timeoutMs: 5000 });
  expect(r.exitCode).toBe(0);
  expect(r.pendingWritten).toBe(false);
});

test("detached + bypassPermissions mode never blocks, even for Bash", async () => {
  const r = await runHook(
    base({ tool_name: "Bash", permission_mode: "bypassPermissions", session_id: "itest-bypass", tool_input: { command: "rm -rf x" } }),
    { timeoutMs: 5000 },
  );
  expect(r.exitCode).toBe(0);
  expect(r.pendingWritten).toBe(false);
});

test("the blocked hook stamps its OWN pid on the marker (readers probe it for liveness)", async () => {
  // Must be read while the hook is still blocked: once a decision lands, the hook consumes
  // it and `rm -f`s the marker before exiting, so a post-exit read finds nothing.
  const sid = "itest-pid";
  rmSync(`${decisionsDir}/${sid}.json`, { force: true });
  rmSync(`${pendingDir}/${sid}.json`, { force: true });
  const payload = base({ tool_name: "Bash", session_id: sid, tool_input: { command: "echo hi" } });
  const proc = Bun.spawn(["bash", hookPath], {
    stdin: Buffer.from(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: TEST_HOME, PATH: `${stubBin}:${process.env.PATH}`, TMUX_PANE: "%1" },
  });

  const marker = `${pendingDir}/${sid}.json`;
  for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(50);
  const raw = JSON.parse(readFileSync(marker, "utf8"));
  proc.kill();
  await proc.exited;

  // `$$` in the template is the spawned bash's own pid — exact equality, not just a
  // typeof check, so a broken escaping (`"$"`, an empty field) can't slip through.
  expect(raw.pid).toBe(proc.pid);
});

test("detached + Bash (default mode) STILL block-polls and honors an allow decision", async () => {
  // Pre-place the decision so the first poll iteration resolves immediately —
  // reaching the allow JSON proves the call took the (correct) block branch.
  const sid = "itest-bash";
  mkdirSync(decisionsDir, { recursive: true });
  writeFileSync(`${decisionsDir}/${sid}.json`, JSON.stringify({ decision: "allow" }));
  const r = await runHook(
    base({ tool_name: "Bash", session_id: sid, tool_input: { command: "echo hi" } }),
    { timeoutMs: 5000 },
  );
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('"permissionDecision":"allow"');
});
