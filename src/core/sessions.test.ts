/**
 * `slashCommandIntent` — turns a Claude Code slash-command user message into a
 * clean naming signal. Skill-launched sessions (e.g. `/implement-plan`) store the
 * real intent only in the command block; the message that follows is generic
 * skill boilerplate ("Base directory for this skill: …"). Naming off the
 * boilerplate produced unstable, hallucinated names (a csm session got named
 * `papi-list-methods`); surfacing the command makes it stable.
 */

import { test, expect } from "bun:test";
import { slashCommandIntent, resolvePaneSessionId } from "./sessions";

test("extracts /implement-plan with its plan path", () => {
  const msg =
    "<command-message>implement-plan</command-message>\n" +
    "<command-name>/implement-plan</command-name>\n" +
    "<command-args>@.plans/native-status/plan.md</command-args>";
  expect(slashCommandIntent(msg)).toBe("/implement-plan @.plans/native-status/plan.md");
});

test("skips meta commands that carry no intent", () => {
  const clear =
    "<command-name>/clear</command-name>\n" +
    "<command-message>clear</command-message>\n" +
    "<command-args></command-args>";
  expect(slashCommandIntent(clear)).toBeNull();
  expect(slashCommandIntent("<command-name>/compact</command-name><command-args></command-args>")).toBeNull();
});

test("command with no args returns just the name", () => {
  expect(slashCommandIntent("<command-name>/review</command-name><command-args></command-args>")).toBe("/review");
});

test("returns null for plain text and for non-command XML (caveats)", () => {
  expect(slashCommandIntent("fix the auth bug")).toBeNull();
  expect(slashCommandIntent("<local-command-caveat>Caveat: …</local-command-caveat>")).toBeNull();
});

test("collapses whitespace in args", () => {
  const msg = "<command-name>/run</command-name><command-args>  foo   bar  </command-args>";
  expect(slashCommandIntent(msg)).toBe("/run foo bar");
});

// --- resolvePaneSessionId — the /clear pane→session precedence fix ---------------
// The SessionStart hook is authoritative; the command-line --resume id is the LAUNCH id
// and goes stale after /clear or /compact (new id, same process). Hook map must win.

const cache = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));

test("resolvePaneSessionId: hook cache wins over the command-line --resume id (the /clear fix)", () => {
  expect(resolvePaneSessionId("%651", "old", cache({ "%651": "new" }), {})).toBe("new");
});

test("resolvePaneSessionId: persisted hook map (pane-sessions.json) wins over the command-line id", () => {
  // The cache lost the truncate-once hook-events race; the monitor-maintained disk map still has it.
  expect(resolvePaneSessionId("%651", "old", cache(), { "%651": "new" })).toBe("new");
});

test("resolvePaneSessionId: cache preferred over persisted (both hook-derived)", () => {
  expect(resolvePaneSessionId("%651", "old", cache({ "%651": "fromCache" }), { "%651": "fromDisk" })).toBe("fromCache");
});

test("resolvePaneSessionId: unhooked pane falls back to the command-line id", () => {
  expect(resolvePaneSessionId("%9", "cmdId", cache(), {})).toBe("cmdId");
});

test("resolvePaneSessionId: fork/fresh pane (no command-line id, no hook entry) → undefined", () => {
  expect(resolvePaneSessionId("%9", undefined, cache(), {})).toBeUndefined();
});

test("resolvePaneSessionId: normal pane (hook == cmd) resolves unchanged — fix is a no-op", () => {
  expect(resolvePaneSessionId("%1", "s1", cache({ "%1": "s1" }), { "%1": "s1" })).toBe("s1");
});

// --- fork override — the fork/status-sync fix ------------------------------------
// A fork's SessionStart hook fires with the PARENT id, so the hook map (cache AND
// persisted) points the fork at its parent → it renders the parent's running status.
// For a fork, cmdSessionId is the REAL id (from Claude's per-pid native file) and
// must win over the poisoned hook map.

test("resolvePaneSessionId: fork's native id wins over the parent id in cache/persisted", () => {
  expect(
    resolvePaneSessionId("%146", "fork-real", cache({ "%146": "parent" }), { "%146": "parent" }, true),
  ).toBe("fork-real");
});

test("resolvePaneSessionId: fork with no native id yet falls back to the hook map (transient)", () => {
  // Native file not written in the split second after boot — keep the hook value
  // until nativeSessionIdByPid resolves; still better than nothing.
  expect(resolvePaneSessionId("%146", undefined, cache({ "%146": "parent" }), {}, true)).toBe("parent");
});

test("resolvePaneSessionId: isFork=false leaves the hook-wins precedence intact (/clear path)", () => {
  // The override is fork-scoped: a /clear'd pane (same process, new hook id) still
  // trusts the hook map over the stale command-line id.
  expect(resolvePaneSessionId("%651", "old", cache({ "%651": "new" }), {}, false)).toBe("new");
});
