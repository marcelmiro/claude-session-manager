/**
 * Config load — pins the retired-key auto-strip (ntfy → Web Push migration):
 * `ntfyTopic`/`bridgeUrl` are removed from config.json on load, operating on the
 * raw JSON so keys this version doesn't know about survive the rewrite.
 *
 * `home` helper first — freezes PATHS under a temp HOME.
 */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { PATHS, loadConfig } from "./config";

beforeEach(() => {
  rmSync(PATHS.config, { force: true });
  mkdirSync(PATHS.dir, { recursive: true });
});

test("loadConfig strips retired keys from config.json, preserving unknown keys", async () => {
  writeFileSync(
    PATHS.config,
    JSON.stringify({
      statusMonitor: false,
      ntfyTopic: "old-topic",
      bridgeUrl: "https://old.ts.net",
      futureKey: { keep: true },
    }),
  );
  const config = await loadConfig();
  expect(config.statusMonitor).toBe(false);
  expect("ntfyTopic" in config).toBe(false);

  const rewritten = JSON.parse(readFileSync(PATHS.config, "utf8"));
  expect(rewritten).toEqual({ statusMonitor: false, futureKey: { keep: true } });
});

test("loadConfig leaves a clean config.json untouched", async () => {
  const clean = JSON.stringify({ statusMonitor: true, repoPaths: ["~/Documents"] });
  writeFileSync(PATHS.config, clean);
  await loadConfig();
  expect(readFileSync(PATHS.config, "utf8")).toBe(clean); // no cosmetic rewrite
});
