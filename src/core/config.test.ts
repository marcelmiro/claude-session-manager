/** Versioned, materialized, single-file user configuration. */

import "../../test/helpers/home";
import { test, expect, beforeEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { PATHS, ensureUserConfig, loadConfig, parseConfigJson, validateConfig } from "./config";

beforeEach(() => {
  rmSync(PATHS.dir, { recursive: true, force: true });
  mkdirSync(PATHS.dir, { recursive: true });
});

test("ensureUserConfig materializes complete defaults and the editor schema", async () => {
  expect(await ensureUserConfig()).toBe(true);
  const config = JSON.parse(readFileSync(PATHS.config, "utf8"));
  expect(config).toMatchObject({
    $schema: "./config.schema.json",
    schemaVersion: 1,
    repositories: { roots: ["~/dev"], priority: [] },
  });
  expect(readFileSync(PATHS.configSchema, "utf8")).toContain('"schemaVersion"');

  const original = readFileSync(PATHS.config, "utf8");
  expect(await ensureUserConfig()).toBe(false);
  expect(readFileSync(PATHS.config, "utf8")).toBe(original);
});

test("loadConfig migrates flat config and terminal sidecars without losing effective values", async () => {
  writeFileSync(PATHS.config, JSON.stringify({
    statusMonitor: false,
    repoPaths: ["~/Code"],
    priorityRepos: ["customeros"],
    ntfyTopic: "retired",
  }));
  writeFileSync(`${PATHS.dir}/terminal-mode`, "remote\n");
  writeFileSync(`${PATHS.dir}/remote-host`, "vm.example.ts.net\n");

  const [config, concurrent] = await Promise.all([loadConfig(), loadConfig()]);
  expect(concurrent).toEqual(config);
  expect(config.repositories).toEqual({ roots: ["~/Code"], priority: ["customeros"] });
  expect(config.ui.statusMonitor).toBe(false);
  expect(config.terminal).toMatchObject({ defaultTarget: "remote", remoteHost: "vm.example.ts.net" });

  const rewritten = JSON.parse(readFileSync(PATHS.config, "utf8"));
  expect(rewritten.schemaVersion).toBe(1);
  expect(rewritten.ntfyTopic).toBeUndefined();
  // Kept until setup installs the new launcher; `csm config` alone must not break
  // an older installed terminal launcher that still reads these files.
  expect(readFileSync(`${PATHS.dir}/terminal-mode`, "utf8")).toBe("remote\n");
  expect(readFileSync(`${PATHS.dir}/remote-host`, "utf8")).toBe("vm.example.ts.net\n");
});

test("loadConfig preserves the old implicit priority during a legacy empty-object migration", async () => {
  writeFileSync(PATHS.config, "{}");
  const config = await loadConfig();
  expect(config.repositories.priority).toEqual(["throxy", "customeros", "~", "csm"]);
});

test("loadConfig leaves a valid v1 file byte-identical", async () => {
  await ensureUserConfig();
  const clean = readFileSync(PATHS.config, "utf8");
  await loadConfig();
  expect(readFileSync(PATHS.config, "utf8")).toBe(clean);
});

test("invalid JSON and unknown keys are rejected instead of silently defaulted", async () => {
  expect(() => parseConfigJson("{nope")).toThrow("Invalid JSON");
  const config = JSON.parse(readFileSync(`${import.meta.dir}/../../config/default.json`, "utf8"));
  config.typo = true;
  expect(() => validateConfig(config)).toThrow("unknown key: typo");
});
