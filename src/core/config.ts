import { homedir } from "os";
import { writeFileSync, renameSync } from "node:fs";
import type { CsmConfig } from "../types";

// CSM_HOME overrides the home root (tests point it at a temp dir; bun's
// os.homedir() ignores a runtime-set $HOME, so an env seam is the reliable hook).
const CSM_DIR = `${process.env.CSM_HOME ?? homedir()}/.config/csm`;

export const PATHS = {
  dir: CSM_DIR,
  config: `${CSM_DIR}/config.json`,
  state: `${CSM_DIR}/state.json`,
  uploads: `${CSM_DIR}/uploads`, // images uploaded from the mobile bridge, pasted into a pane
} as const;

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

const DEFAULT_CONFIG: CsmConfig = {
  statusMonitor: true,
  windowPrefix: true,
  nativeNotification: true,
  repoPaths: ["~/Documents"],
  priorityRepos: ["throxy"],
};

// Retired by the ntfy → Web Push migration; stripped from config.json on load so
// future readers aren't left wondering why editing them does nothing.
const RETIRED_KEYS = ["ntfyTopic", "bridgeUrl"] as const;

export async function loadConfig(): Promise<CsmConfig> {
  try {
    const raw = await Bun.file(PATHS.config).text();
    const parsed = JSON.parse(raw);
    stripRetiredKeys(parsed);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Drop retired keys from the raw parsed config (never the typed shape — unknown
 * keys a future version may add must survive the rewrite) and persist atomically.
 * Concurrent strippers (TUI + monitor + bridge on first post-upgrade load) all
 * write the same result, so the rename race is benign.
 */
function stripRetiredKeys(parsed: Record<string, unknown>): void {
  try {
    const stale = RETIRED_KEYS.filter((k) => k in parsed);
    if (stale.length === 0) return;
    for (const k of stale) delete parsed[k];
    writeAtomic(PATHS.config, JSON.stringify(parsed, null, 2));
  } catch {
    // Non-fatal — stale keys linger in the file but are ignored either way.
  }
}

export async function saveConfig(config: CsmConfig): Promise<void> {
  try {
    await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
    await Bun.write(PATHS.config, JSON.stringify(config, null, 2));
  } catch {
    // Non-fatal
  }
}
