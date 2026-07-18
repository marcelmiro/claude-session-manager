/**
 * `setup()` idempotency (Inc setup). Two runs under a temp $HOME must leave exactly
 * one CSM registration per event, preserve pre-existing user hooks + other settings
 * keys, and write the hook scripts stamped CSM_HOOK_VERSION=10.
 *
 * `home` helper first — cli → hook-events → config freezes paths from $HOME; setup
 * itself re-reads homedir() at call time, so it targets the same temp HOME.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { setup } from "./cli";

const claudeDir = `${TEST_HOME}/.claude`;
const settingsPath = `${claudeDir}/settings.json`;
const hooksDir = `${TEST_HOME}/.config/csm/hooks`;
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreToolUse",
];

beforeEach(() => {
  rmSync(claudeDir, { recursive: true, force: true });
  rmSync(hooksDir, { recursive: true, force: true });
  mkdirSync(claudeDir, { recursive: true });
  // Pre-existing user content that setup() must NOT clobber.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-own-hook" }] }],
      },
    }),
  );
});

/** Count CSM registrations (command points into the CSM hooks dir) for an event. */
function csmEntries(settings: any, event: string): any[] {
  const entries = settings.hooks?.[event] ?? [];
  return entries.filter(
    (e: any) =>
      Array.isArray(e.hooks) &&
      e.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(hooksDir)),
  );
}

test("running setup() twice leaves exactly one CSM entry per event and preserves user content", async () => {
  await setup();
  await setup();

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

  // Other top-level keys preserved.
  expect(settings.model).toBe("opus");

  // Exactly one CSM registration per event after two runs (idempotent).
  for (const event of EVENTS) {
    expect(csmEntries(settings, event)).toHaveLength(1);
  }

  // The pre-existing user hook on SessionStart survives alongside the CSM one.
  const userHook = settings.hooks.SessionStart.some(
    (e: any) => e.hooks.some((h: any) => h.command === "/usr/local/bin/my-own-hook"),
  );
  expect(userHook).toBe(true);
  expect(settings.hooks.SessionStart.length).toBe(2); // user + CSM

  // PreToolUse carries the 600s blocking timeout.
  const pre = csmEntries(settings, "PreToolUse")[0];
  expect(pre.hooks[0].timeout).toBe(600);
});

test("setup() writes the three hook scripts stamped CSM_HOOK_VERSION=10", async () => {
  await setup();
  for (const name of ["session-start", "event", "pretooluse"]) {
    const path = `${hooksDir}/${name}.sh`;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("# CSM_HOOK_VERSION=10");
  }
});

test("pretooluse.sh branches AskUserQuestion to the focus-aware question intercept", async () => {
  await setup();
  const pre = readFileSync(`${hooksDir}/pretooluse.sh`, "utf8");
  // The intercept branch: tracked pane + live marker + focus, then csm question-hook.
  expect(pre).toContain('if [ "$TOOL" = "AskUserQuestion" ]');
  expect(pre).toContain("csm question-hook");
  expect(pre).toContain("bridge-consumer");
  // No claude-version gate (dropped 2026-07-18) — updatedInput is assumed forward-compatible.
  expect(pre).not.toContain("claude --version");
  expect(pre).not.toContain("RUNNING");
});
