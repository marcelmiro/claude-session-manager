/**
 * `setup()` idempotency (Inc setup). Two runs under a temp $HOME must leave exactly
 * one CSM registration per event, preserve pre-existing user hooks + other settings
 * keys, and write the hook scripts stamped CSM_HOOK_VERSION=12.
 *
 * `home` helper first — cli → hook-events → config freezes paths from $HOME; setup
 * itself re-reads homedir() at call time, so it targets the same temp HOME.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { setup } from "./cli";
import { HOLD_WINDOW_MS } from "./core/approval";

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

/** The CSM registration for an event whose command runs the given script. */
function csmEntry(settings: any, event: string, script: string): any {
  return csmEntries(settings, event).find((e: any) =>
    e.hooks.some((h: any) => typeof h.command === "string" && h.command.includes(script)),
  );
}

test("running setup() twice leaves exactly one CSM entry per event and preserves user content", async () => {
  await setup();
  await setup();

  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

  // Other top-level keys preserved.
  expect(settings.model).toBe("opus");

  // Idempotent per script after two runs: one CSM registration per event, except
  // PreToolUse, which deliberately carries two (approval + matcher-scoped question).
  for (const event of EVENTS) {
    expect(csmEntries(settings, event)).toHaveLength(event === "PreToolUse" ? 2 : 1);
  }

  // The pre-existing user hook on SessionStart survives alongside the CSM one.
  const userHook = settings.hooks.SessionStart.some(
    (e: any) => e.hooks.some((h: any) => h.command === "/usr/local/bin/my-own-hook"),
  );
  expect(userHook).toBe(true);
  expect(settings.hooks.SessionStart.length).toBe(2); // user + CSM

  // The approval hook keeps the short kill deadline (600s window + grace) — a hung
  // ordinary tool call must stay killable; only the question entry may hold for hours.
  const pre = csmEntry(settings, "PreToolUse", "/pretooluse.sh");
  expect(pre.hooks[0].timeout).toBe(615);
  expect(pre.matcher).toBeUndefined(); // all tools
  const q = csmEntry(settings, "PreToolUse", "/question-pretooluse.sh");
  expect(q.matcher).toBe("AskUserQuestion");
  expect(q.hooks[0].timeout).toBe(14415); // 4h question window + kill grace
});

test("the registered kill timeout outlasts the window the hook poll loops run to", async () => {
  // Claude counts its timeout from hook spawn; the loops can only start once the process
  // is up. If the kill isn't strictly later, it lands first and the hook dies before the
  // cleanup that un-registers its marker — the orphan the pid gate then has to catch.
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const registered = csmEntries(settings, "PreToolUse")[0].hooks[0].timeout * 1000;
  expect(registered).toBeGreaterThan(HOLD_WINDOW_MS);
});

test("setup() repairs a stale timeout on an already-registered hook", async () => {
  // The registration is matched on command path, so without an explicit reconcile an
  // install from an older version would keep its old kill deadline forever.
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  csmEntries(settings, "PreToolUse")[0].hooks[0].timeout = 600; // as an older version left it
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  await setup();
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(csmEntry(after, "PreToolUse", "/pretooluse.sh").hooks[0].timeout).toBe(615);
  expect(csmEntries(after, "PreToolUse")).toHaveLength(2); // repaired, not duplicated
});

test("setup() writes the four hook scripts stamped CSM_HOOK_VERSION=13", async () => {
  await setup();
  for (const name of ["session-start", "event", "pretooluse", "question-pretooluse"]) {
    const path = `${hooksDir}/${name}.sh`;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("# CSM_HOOK_VERSION=13");
  }
});

test("AskUserQuestion is delegated: pretooluse.sh exits for it, question-pretooluse.sh intercepts", async () => {
  await setup();
  const pre = readFileSync(`${hooksDir}/pretooluse.sh`, "utf8");
  // The approval script logs the event, then bails — its short kill timeout must never
  // apply to a question hold, and the matched entry would otherwise double-intercept.
  expect(pre).toContain('[ "$TOOL" = "AskUserQuestion" ] && exit 0');
  expect(pre).not.toContain("csm question-hook");
  const q = readFileSync(`${hooksDir}/question-pretooluse.sh`, "utf8");
  // The intercept gates: tracked pane + live marker + focus, then csm question-hook.
  expect(q).toContain("csm question-hook");
  expect(q).toContain("bridge-consumer");
  expect(q).toContain("panes/$TMUX_PANE");
  expect(q).toContain("lsappinfo");
  // No claude-version gate (dropped 2026-07-18) — updatedInput is assumed forward-compatible.
  expect(q).not.toContain("claude --version");
});
