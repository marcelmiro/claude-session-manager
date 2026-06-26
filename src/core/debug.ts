/**
 * Opt-in debug logging — active only when `~/.config/csm/debug.log` exists (create
 * the file to enable, delete to disable). Shared by the monitor and the headless
 * status core. Auto-truncating so it never grows unbounded; all IO in try/catch so
 * a logging failure can never crash a caller.
 */

import { existsSync } from "node:fs";
import { PATHS } from "./config";

const DEBUG_LOG_PATH = `${PATHS.dir}/debug.log`;
let debugEnabled: boolean | null = null;

export async function debugLog(msg: string): Promise<void> {
  if (debugEnabled === null) debugEnabled = existsSync(DEBUG_LOG_PATH);
  if (!debugEnabled) return;
  try {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const line = `${ts} ${msg}\n`;
    const file = Bun.file(DEBUG_LOG_PATH);
    const existing = (await file.exists()) ? await file.text() : "";
    // Auto-truncate: keep last 900 lines when over 1000.
    const lines = existing.split("\n");
    const trimmed = lines.length > 1000 ? lines.slice(-900).join("\n") + "\n" : existing;
    await Bun.write(DEBUG_LOG_PATH, trimmed + line);
  } catch {
    debugEnabled = false; // non-fatal — disable for the rest of this run
  }
}

/**
 * Durable probation log for the `QUIET_MS` demotion (ADR-4 on probation). Unlike
 * `debugLog`, this is ALWAYS written (not gated by debug.log) and lives in its own
 * file, so a rare demotion survives for days instead of being truncated away by
 * routine monitor spam. The event is rare by hypothesis, so the IO is negligible;
 * a high line count means it fires often — itself the answer (fix the hook / keep).
 */
const QUIET_PROBATION_PATH = `${PATHS.dir}/quiet-demotes.log`;

export async function recordQuietDemote(msg: string): Promise<void> {
  try {
    const ts = new Date().toISOString();
    const file = Bun.file(QUIET_PROBATION_PATH);
    const existing = (await file.exists()) ? await file.text() : "";
    const lines = existing.split("\n");
    const trimmed = lines.length > 2000 ? lines.slice(-1500).join("\n") + "\n" : existing;
    await Bun.write(QUIET_PROBATION_PATH, `${trimmed}${ts} ${msg}\n`);
  } catch {
    // non-fatal — probation logging must never affect status detection
  }
}
