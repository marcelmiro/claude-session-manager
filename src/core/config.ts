import { homedir } from "os";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import defaultConfigJson from "../../config/default.json";
import type { CsmConfig } from "../types";

// CLAUDE0_HOME overrides the home root (tests point it at a temp dir; bun's
// os.homedir() ignores a runtime-set $HOME, so an env seam is the reliable hook).
const C0_DIR = `${process.env.CLAUDE0_HOME ?? homedir()}/.config/c0`;

export const PATHS = {
  dir: C0_DIR,
  config: `${C0_DIR}/config.json`,
  configSchema: `${C0_DIR}/config.schema.json`,
  state: `${C0_DIR}/state.json`,
  uploads: `${C0_DIR}/uploads`, // images uploaded from the mobile bridge, pasted into a pane
} as const;

const DEFAULT_CONFIG = defaultConfigJson as CsmConfig;
const LEGACY_DEFAULT_PRIORITY = ["throxy", "customeros", "~", "csm"];
const RETIRED_KEYS = new Set(["ntfyTopic", "bridgeUrl"]);
const LEGACY_TERMINAL_FILES = ["terminal-mode", "remote-host", "local-session", "remote-session"];
const CONFIG_MIGRATION_LOCK = `${C0_DIR}/config-migration.lock`;

/**
 * Write `text` to `path` atomically (tmp→rename) so a concurrent reader never
 * sees a half-written file. Shared by every state-file writer under PATHS.dir.
 * Throws on failure — callers decide whether that's fatal.
 */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function cloneDefault(): CsmConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsAt(value: unknown, path: string, { nonEmpty = false } = {}): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (nonEmpty && item.length === 0))) {
    throw new Error(`${path} must be an array of${nonEmpty ? " non-empty" : ""} strings`);
  }
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${path} contains unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}`);
}

/** Validate the complete v1 file. Config mistakes are surfaced, never silently defaulted. */
export function validateConfig(value: unknown): CsmConfig {
  if (!isObject(value)) throw new Error("config must be a JSON object");
  onlyKeys(value, ["$schema", "schemaVersion", "repositories", "terminal", "ui", "notifications"], "config");
  if (value.schemaVersion !== 1) throw new Error(`schemaVersion must be 1 (received ${String(value.schemaVersion)})`);
  if (value.$schema !== undefined && typeof value.$schema !== "string") throw new Error("$schema must be a string");

  if (!isObject(value.repositories)) throw new Error("repositories must be an object");
  onlyKeys(value.repositories, ["roots", "priority"], "repositories");
  const roots = stringsAt(value.repositories.roots, "repositories.roots", { nonEmpty: true });
  if (roots.length === 0) throw new Error("repositories.roots must contain at least one directory");
  const priority = stringsAt(value.repositories.priority, "repositories.priority", { nonEmpty: true });

  if (!isObject(value.terminal)) throw new Error("terminal must be an object");
  onlyKeys(value.terminal, ["defaultTarget", "remoteHost", "localSession", "remoteSession"], "terminal");
  if (value.terminal.defaultTarget !== "local" && value.terminal.defaultTarget !== "remote") {
    throw new Error('terminal.defaultTarget must be "local" or "remote"');
  }
  if (value.terminal.remoteHost !== null && typeof value.terminal.remoteHost !== "string") {
    throw new Error("terminal.remoteHost must be a string or null");
  }

  if (!isObject(value.ui)) throw new Error("ui must be an object");
  onlyKeys(value.ui, ["statusMonitor", "windowPrefix"], "ui");
  if (!isObject(value.notifications)) throw new Error("notifications must be an object");
  onlyKeys(value.notifications, ["native"], "notifications");

  return {
    ...(value.$schema === undefined ? {} : { $schema: value.$schema }),
    schemaVersion: 1,
    repositories: { roots, priority },
    terminal: {
      defaultTarget: value.terminal.defaultTarget,
      remoteHost: value.terminal.remoteHost,
      localSession: stringAt(value.terminal.localSession, "terminal.localSession"),
      remoteSession: stringAt(value.terminal.remoteSession, "terminal.remoteSession"),
    },
    ui: {
      statusMonitor: booleanAt(value.ui.statusMonitor, "ui.statusMonitor"),
      windowPrefix: booleanAt(value.ui.windowPrefix, "ui.windowPrefix"),
    },
    notifications: { native: booleanAt(value.notifications.native, "notifications.native") },
  };
}

/** Parse JSON separately so syntax diagnostics can be tested without mutating user state. */
export function parseConfigJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function legacySetting(name: string, fallback: string | null): Promise<string | null> {
  try {
    const text = (await Bun.file(`${PATHS.dir}/${name}`).text()).trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

/** Convert the pre-v1 flat shape and terminal sidecar files into the single v1 file. */
async function migrateLegacyConfig(raw: Record<string, unknown>): Promise<CsmConfig> {
  const known = new Set(["statusMonitor", "windowPrefix", "nativeNotification", "repoPaths", "priorityRepos"]);
  const unknown = Object.keys(raw).filter((key) => !known.has(key) && !RETIRED_KEYS.has(key));
  if (unknown.length) throw new Error(`legacy config contains unknown ${unknown.length === 1 ? "key" : "keys"}: ${unknown.join(", ")}`);

  const target = await legacySetting("terminal-mode", "local");
  const remoteHost = await legacySetting("remote-host", null);
  return {
    $schema: "./config.schema.json",
    schemaVersion: 1,
    repositories: {
      roots: raw.repoPaths === undefined ? ["~/Documents"] : stringsAt(raw.repoPaths, "repoPaths", { nonEmpty: true }),
      priority: raw.priorityRepos === undefined
        ? [...LEGACY_DEFAULT_PRIORITY]
        : stringsAt(raw.priorityRepos, "priorityRepos", { nonEmpty: true }),
    },
    terminal: {
      defaultTarget: target === "remote" ? "remote" : "local",
      remoteHost,
      localSession: (await legacySetting("local-session", "main"))!,
      remoteSession: (await legacySetting("remote-session", "main"))!,
    },
    ui: {
      statusMonitor: raw.statusMonitor === undefined ? true : booleanAt(raw.statusMonitor, "statusMonitor"),
      windowPrefix: raw.windowPrefix === undefined ? true : booleanAt(raw.windowPrefix, "windowPrefix"),
    },
    notifications: {
      native: raw.nativeNotification === undefined ? true : booleanAt(raw.nativeNotification, "nativeNotification"),
    },
  };
}

/** Serialize the one-time migration across TUI/monitor/bridge startup. */
async function migrateLegacyConfigOnce(): Promise<CsmConfig> {
  let ownsLock = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(CONFIG_MIGRATION_LOCK);
      ownsLock = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another process owns the migration. Once its atomic config write lands,
      // consume that result rather than racing its sidecar reads/removals.
      await Bun.sleep(50);
      try {
        const current = parseConfigJson(await Bun.file(PATHS.config).text());
        if (isObject(current) && current.schemaVersion !== undefined) return validateConfig(current);
      } catch {
        // Writer has not committed yet; keep waiting for the bounded interval.
      }
    }
  }
  if (!ownsLock) throw new Error(`timed out waiting for ${CONFIG_MIGRATION_LOCK}; remove it only if no Claude0 process is migrating config`);

  try {
    // The config may have been migrated between our initial read and lock acquisition.
    const current = parseConfigJson(await Bun.file(PATHS.config).text());
    if (isObject(current) && current.schemaVersion !== undefined) return validateConfig(current);
    if (!isObject(current)) throw new Error("legacy config must be a JSON object");
    const migrated = await migrateLegacyConfig(current);
    writeAtomic(PATHS.config, `${JSON.stringify(migrated, null, 2)}\n`);
    return migrated;
  } finally {
    rmSync(CONFIG_MIGRATION_LOCK, { recursive: true, force: true });
  }
}

export async function loadConfig(): Promise<CsmConfig> {
  let text: string;
  try {
    text = await Bun.file(PATHS.config).text();
  } catch {
    return cloneDefault();
  }

  let raw: unknown;
  try {
    raw = parseConfigJson(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message.replace(/^Invalid JSON:\s*/, "") : String(error);
    throw new Error(`Invalid JSON in ${PATHS.config}: ${detail}`);
  }

  try {
    if (isObject(raw) && raw.schemaVersion === undefined) {
      return await migrateLegacyConfigOnce();
    }
    return validateConfig(raw);
  } catch (error) {
    throw new Error(`Invalid Claude0 config at ${PATHS.config}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Install discoverable defaults/schema without ever overwriting a user's config. */
export async function ensureUserConfig(): Promise<boolean> {
  mkdirSync(PATHS.dir, { recursive: true });
  let created = false;
  if (!(await Bun.file(PATHS.config).exists())) {
    writeAtomic(PATHS.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    created = true;
  }
  const schemaSource = `${import.meta.dir}/../../config/config.schema.json`;
  const schema = await Bun.file(schemaSource).text();
  if (!(await Bun.file(PATHS.configSchema).exists()) || (await Bun.file(PATHS.configSchema).text()) !== schema) {
    writeAtomic(PATHS.configSchema, schema);
  }
  // Validate (and migrate) after the schema is present so editor diagnostics work immediately.
  await loadConfig();
  return created;
}

/**
 * Retire terminal sidecars only after setup has installed the config.json-aware
 * launcher. `c0 config` may migrate JSON while an older launcher is still live;
 * deleting its inputs there would silently reset terminal attachment behavior.
 */
export function removeLegacyConfigSidecars(): void {
  for (const name of LEGACY_TERMINAL_FILES) rmSync(`${PATHS.dir}/${name}`, { force: true });
}

export async function saveConfig(config: CsmConfig): Promise<void> {
  mkdirSync(PATHS.dir, { recursive: true });
  const validated = validateConfig(config);
  writeAtomic(PATHS.config, `${JSON.stringify(validated, null, 2)}\n`);
}
