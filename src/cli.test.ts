/**
 * `setup()` idempotency (Inc setup). Two runs under a temp $HOME must leave exactly
 * one CSM registration per event, preserve pre-existing user hooks + other settings
 * keys, and write the hook scripts stamped with the current CSM_HOOK_VERSION.
 *
 * `home` helper first — cli → hook-events → config freezes paths from $HOME; setup
 * itself re-reads homedir() at call time, so it targets the same temp HOME.
 */

import "../test/helpers/home";
import { TEST_HOME } from "../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readlinkSync, existsSync } from "node:fs";
import { setup, HOOK_VERSION } from "./cli";
import { HOLD_WINDOW_MS } from "./core/approval";

const claudeDir = `${TEST_HOME}/.claude`;
const settingsPath = `${claudeDir}/settings.json`;
const csmDir = `${TEST_HOME}/.config/csm`;
const hooksDir = `${csmDir}/hooks`;
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
  rmSync(csmDir, { recursive: true, force: true });
  rmSync(`${TEST_HOME}/.local/bin/csm`, { force: true });
  rmSync(`${TEST_HOME}/.local/bin/csm-terminal`, { force: true });
  rmSync(`${TEST_HOME}/.zshrc`, { force: true });
  rmSync(`${TEST_HOME}/.tmux.conf`, { force: true });
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

test("setup installs CSM-owned terminal fragments and imports them idempotently", async () => {
  writeFileSync(`${TEST_HOME}/.zshrc`, "# user zsh config\n");
  writeFileSync(`${TEST_HOME}/.tmux.conf`, "# user tmux config\n");
  mkdirSync(`${TEST_HOME}/.local/bin`, { recursive: true });
  writeFileSync(
    `${TEST_HOME}/.local/bin/csm-terminal`,
    "#!/bin/sh\n# Start the local or remote tmux environment used by CSM.\n",
  );

  await setup();
  await setup();

  expect(readFileSync(`${csmDir}/shell.zsh`, "utf8")).not.toContain("alias csm-local=");
  expect(readFileSync(`${csmDir}/tmux.conf`, "utf8")).toContain("display-popup -E");
  expect(readlinkSync(`${TEST_HOME}/.local/bin/csm`)).toBe(`${import.meta.dir}/../bin/csm.ts`);
  expect(readFileSync(`${csmDir}/terminal-launcher`, "utf8")).toContain(
    "MOSH_SERVER_NETWORK_TMOUT=2592000",
  );
  expect(existsSync(`${TEST_HOME}/.local/bin/csm-terminal`)).toBe(false);

  const zshrc = readFileSync(`${TEST_HOME}/.zshrc`, "utf8");
  const tmux = readFileSync(`${TEST_HOME}/.tmux.conf`, "utf8");
  expect(zshrc).toContain("# user zsh config");
  expect(tmux).toContain("# user tmux config");
  expect(zshrc.match(/\.config\/csm\/shell\.zsh/g)).toHaveLength(2); // test + source in one import line
  expect(tmux.match(/\.config\/csm\/tmux\.conf/g)).toHaveLength(2); // test + source in one import line
});

test("setup migrates terminal sidecars before retiring them", async () => {
  mkdirSync(csmDir, { recursive: true });
  writeFileSync(`${csmDir}/config.json`, "{}");
  writeFileSync(`${csmDir}/terminal-mode`, "remote\n");
  writeFileSync(`${csmDir}/remote-host`, "vm.example.ts.net\n");

  await setup();

  const config = JSON.parse(readFileSync(`${csmDir}/config.json`, "utf8"));
  expect(config.terminal).toMatchObject({ defaultTarget: "remote", remoteHost: "vm.example.ts.net" });
  expect(existsSync(`${csmDir}/terminal-mode`)).toBe(false);
  expect(existsSync(`${csmDir}/remote-host`)).toBe(false);
  expect(readFileSync(`${csmDir}/terminal-launcher`, "utf8")).toContain('config_file="$HOME/.config/csm/config.json"');
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

  // Idempotent per script after two runs. PreToolUse deliberately carries two
  // registrations (approval + question).
  for (const event of EVENTS) {
    const wanted = event === "PreToolUse" ? 2 : 1;
    expect(csmEntries(settings, event)).toHaveLength(wanted);
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

test("setup() writes every hook script stamped with the current CSM_HOOK_VERSION", async () => {
  await setup();
  for (const name of [
    "session-start",
    "event",
    "pretooluse",
    "question-pretooluse",
  ]) {
    const path = `${hooksDir}/${name}.sh`;
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(`# CSM_HOOK_VERSION=${HOOK_VERSION}`);
  }
});

test("setup removes retired CSM worktree hooks and scripts but preserves user hooks", async () => {
  mkdirSync(hooksDir, { recursive: true });
  for (const script of ["worktree-create.sh", "worktree-remove.sh", "subagent-worktree-cleanup.sh"]) {
    writeFileSync(`${hooksDir}/${script}`, "#!/bin/bash\n# old CSM hook\n");
  }
  writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      WorktreeCreate: [{ hooks: [
        { type: "command", command: `bash "${hooksDir}/worktree-create.sh"` },
        { type: "command", command: "/usr/local/bin/user-worktree-hook" },
      ] }],
      WorktreeRemove: [{ hooks: [{ type: "command", command: `bash "${hooksDir}/worktree-remove.sh"` }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: `bash "${hooksDir}/subagent-worktree-cleanup.sh"` }] }],
    },
  }));

  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  expect(settings.hooks.WorktreeCreate[0].hooks).toEqual([
    { type: "command", command: "/usr/local/bin/user-worktree-hook" },
  ]);
  expect(settings.hooks.WorktreeRemove).toEqual([]);
  expect(csmEntries(settings, "SubagentStop")).toHaveLength(1); // event logger only
  for (const script of ["worktree-create.sh", "worktree-remove.sh", "subagent-worktree-cleanup.sh"]) {
    expect(existsSync(`${hooksDir}/${script}`)).toBe(false);
  }
});

test("hook gates branch on uname: darwin keeps frontmost/attached probes, elsewhere reads client_activity", async () => {
  // On a remote host a persistent SSH attach is the steady state, so "client
  // attached" stops implying presence — both gates must consult keystroke recency
  // there while leaving the macOS behavior byte-for-byte intact.
  await setup();
  const pre = readFileSync(`${hooksDir}/pretooluse.sh`, "utf8");
  expect(pre).toContain('[ "$(uname)" = "Darwin" ]');
  expect(pre).toContain("#{client_activity}");
  const q = readFileSync(`${hooksDir}/question-pretooluse.sh`, "utf8");
  expect(q).toContain('[ "$(uname)" = "Darwin" ]');
  expect(q).toContain("#{client_activity}");
  expect(q).toContain("lsappinfo"); // darwin branch intact
  // The window constant is interpolated from core/presence.ts, not hand-copied.
  expect(q).toMatch(/-le 60\b/);
  expect(pre).toMatch(/-le 60\b/);
});

test("setup() registers hook commands as explicit quoted bash invocations", async () => {
  // Claude runs hook commands via /bin/sh -c — dash on Debian-family hosts — so the
  // registration must name bash itself, and quote the path against spaces.
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  for (const event of EVENTS) {
    for (const entry of csmEntries(settings, event)) {
      for (const h of entry.hooks) {
        expect(h.command).toMatch(/^bash "[^"]+\.sh"$/);
      }
    }
  }
});

test("setup() upgrades a bare-path command from an older install to the bash form", async () => {
  await setup();
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const entry = csmEntry(settings, "SessionStart", "/session-start.sh");
  entry.hooks[0].command = `${hooksDir}/session-start.sh`; // as an older version registered it
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  await setup();
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  const upgraded = csmEntry(after, "SessionStart", "/session-start.sh");
  expect(upgraded.hooks[0].command).toBe(`bash "${hooksDir}/session-start.sh"`);
  expect(csmEntries(after, "SessionStart")).toHaveLength(1); // upgraded, not duplicated
});

test("question hook reads marker mtime via the GNU→BSD stat fallback chain", async () => {
  // `stat -f %m` is BSD-only; on GNU hosts it fails to `echo 0`, which reads as a
  // dead bridge consumer and silently disables the question intercept entirely.
  await setup();
  const q = readFileSync(`${hooksDir}/question-pretooluse.sh`, "utf8");
  expect(q).toContain('stat -c %Y "$M" 2>/dev/null || stat -f %m "$M" 2>/dev/null || echo 0');
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

test("setup() manages the daemon with launchd only on macOS", async () => {
  const plistPath = `${TEST_HOME}/Library/LaunchAgents/com.csm.daemon.plist`;
  rmSync(plistPath, { force: true });

  await setup();
  if (process.platform !== "darwin") {
    expect(existsSync(plistPath)).toBe(false);
    return;
  }

  const plist = readFileSync(plistPath, "utf8");
  expect(plist).toContain("<string>com.csm.daemon</string>");
  expect(plist).toContain("<string>daemon</string>");
  expect(plist).toContain(`<string>${Bun.which("bun") ?? process.execPath}</string>`);
  expect(plist).toContain("<key>KeepAlive</key><true/>");

  // Second run leaves it byte-identical (the change check gates launchctl reloads).
  await setup();
  expect(readFileSync(plistPath, "utf8")).toBe(plist);
});

test("setup() creates the sidebar autostart marker on a fresh machine", async () => {
  const { PATHS } = await import("./core/config");
  const marker = `${PATHS.dir}/inbox-sidebar-autostart-default`;
  rmSync(marker, { force: true });
  await setup();
  expect(await Bun.file(marker).exists()).toBe(true);
});
