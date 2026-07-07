/**
 * Hook-owned per-pane session map (v7). Verifies the storage swap that fixed the
 * listed-but-unsendable bug: per-pane files are the source of truth, reads are
 * non-destructive (no consume-once race), change-detection still diffs only id
 * CHANGES, and `csm setup` migrates the pre-v7 single-file map forward.
 *
 * Home helper FIRST so CSM_HOME is set before config.ts freezes PATHS.dir.
 */

import "../../test/helpers/home";
import { CSM_DIR } from "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPaneSessions, savePaneSessions, processHookEvents, reconcilePaneFiles, migratePaneMap } from "./state";

const PANES_DIR = join(CSM_DIR, "panes");
const LEGACY_JSON = join(CSM_DIR, "pane-sessions.json");
const HOOK_EVENTS = join(CSM_DIR, "hook-events");

beforeEach(() => {
  rmSync(PANES_DIR, { recursive: true, force: true });
  rmSync(LEGACY_JSON, { force: true });
  rmSync(HOOK_EVENTS, { force: true });
  mkdirSync(CSM_DIR, { recursive: true });
});

test("save/load round-trips per-pane files (the % paneId is a valid filename)", async () => {
  await savePaneSessions({ "%46": "sess-a", "%7": "sess-b" });
  expect(await loadPaneSessions()).toEqual({ "%46": "sess-a", "%7": "sess-b" });
});

test("loadPaneSessions ignores in-flight .tmp files", async () => {
  await savePaneSessions({ "%1": "sess-a" });
  writeFileSync(join(PANES_DIR, "%2.tmp"), "half-written");
  expect(await loadPaneSessions()).toEqual({ "%1": "sess-a" });
});

test("loadPaneSessions falls back to the legacy single-file map when panes/ is absent", async () => {
  writeFileSync(LEGACY_JSON, JSON.stringify({ "%9": "legacy-id" }));
  expect(existsSync(PANES_DIR)).toBe(false);
  expect(await loadPaneSessions()).toEqual({ "%9": "legacy-id" });
});

test("processHookEvents: a NEW pane updates the map but is NOT a change", async () => {
  await savePaneSessions({ "%1": "sess-a" });
  const map: Record<string, string> = {};
  const { changed, changedPaneIds } = await processHookEvents(map);
  expect(changed).toBe(true);
  expect(map["%1"]).toBe("sess-a");
  expect([...changedPaneIds]).toEqual([]); // brand-new ≠ changed
});

test("processHookEvents: a CHANGED id (/clear) is flagged in changedPaneIds", async () => {
  await savePaneSessions({ "%1": "new-id" });
  const map: Record<string, string> = { "%1": "old-id" };
  const { changed, changedPaneIds } = await processHookEvents(map);
  expect(changed).toBe(true);
  expect(map["%1"]).toBe("new-id");
  expect([...changedPaneIds]).toEqual(["%1"]);
});

test("processHookEvents: reading is non-destructive (no truncate race)", async () => {
  await savePaneSessions({ "%1": "sess-a" });
  await processHookEvents({});
  // Second reader still sees the file — the v6 consume-once bug is gone.
  expect(await loadPaneSessions()).toEqual({ "%1": "sess-a" });
});

test("reconcilePaneFiles drops only files for panes absent from tmux", async () => {
  await savePaneSessions({ "%1": "live", "%2": "dead" });
  await reconcilePaneFiles(new Set(["%1"]));
  expect(await loadPaneSessions()).toEqual({ "%1": "live" });
});

test("migratePaneMap folds legacy json + residual hook-events into per-pane files", async () => {
  writeFileSync(LEGACY_JSON, JSON.stringify({ "%1": "from-json" }));
  writeFileSync(HOOK_EVENTS, "%2 from-events\n");
  await migratePaneMap();
  expect(await loadPaneSessions()).toEqual({ "%1": "from-json", "%2": "from-events" });
});
