import { homedir } from "os";
import type { NotificationConfig } from "../types";

const CSM_DIR = `${homedir()}/.config/csm`;

export const PATHS = {
  dir: CSM_DIR,
  config: `${CSM_DIR}/config.json`,
  state: `${CSM_DIR}/state.json`,
} as const;

const DEFAULT_CONFIG: NotificationConfig = {
  statusWidget: true,
  windowPrefix: true,
  bell: true,
  bellOn: "all",
};

export async function loadConfig(): Promise<NotificationConfig> {
  try {
    const raw = await Bun.file(PATHS.config).text();
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: NotificationConfig): Promise<void> {
  try {
    await Bun.$`mkdir -p ${PATHS.dir}`.quiet();
    await Bun.write(PATHS.config, JSON.stringify(config, null, 2));
  } catch {
    // Non-fatal
  }
}
