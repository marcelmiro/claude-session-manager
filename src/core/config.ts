import { homedir } from "os";
import type { CsmConfig } from "../types";

const CSM_DIR = `${homedir()}/.config/csm`;

export const PATHS = {
  dir: CSM_DIR,
  config: `${CSM_DIR}/config.json`,
  state: `${CSM_DIR}/state.json`,
} as const;

const DEFAULT_CONFIG: CsmConfig = {
  statusMonitor: true,
  windowPrefix: true,
  repoPaths: ["~/Documents"],
  priorityRepos: ["throxy"],
};

export async function loadConfig(): Promise<CsmConfig> {
  try {
    const raw = await Bun.file(PATHS.config).text();
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
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
