/**
 * Claude native session-status reader (headless).
 *
 * Claude Code maintains its OWN authoritative status at
 * `~/.claude/sessions/<pid>.json` (`status` = `busy|idle|waiting`). It flips to
 * `idle` ~1.5s after a turn ends — including the revert/interrupt cases that emit
 * NO hook, where the event model's `UserPromptSubmit → running` edge latches and
 * strands a session at "running" forever. Reading this file de-latches that and,
 * more broadly, aligns CSM's displayed status to Claude's own. It's the PRIMARY
 * source for live sessions, with the event model then the scraper as fallbacks.
 *
 * Status mapping (verified empirically): busy→running, idle→ready, waiting→waiting.
 *
 * NOTE on the home root: Claude writes to the REAL home (`homedir()`), not CSM's
 * `CSM_HOME` test seam (config.ts:4-6). This reader intentionally diverges from
 * that seam and takes a `dir` arg for test isolation, because the target dir is
 * Claude's, not CSM's. A future CSM_HOME-based integration test will NOT reach
 * `nativeStatus()` — that's expected, point it at `dir` instead.
 *
 * Headless: no blessed/ui imports (enforced by boundary.test.ts). All IO in
 * try/catch returning empty defaults — never crash the TUI.
 */

import { homedir } from "os";
import { Glob } from "bun";
import type { SessionStatus } from "./status";

const DEFAULT_DIR = `${homedir()}/.claude/sessions`;

// Claude's `status` → CSM's SessionStatus. Anything else → skip (null).
function mapStatus(status: unknown): SessionStatus | null {
  switch (status) {
    case "busy":
      return "running";
    case "idle":
      return "ready";
    case "waiting":
      return "waiting";
    default:
      return null;
  }
}

// process.kill(pid, 0) probes liveness without signalling. Single-user macOS:
// only ESRCH (dead) can throw — EPERM (alive, foreign-owned) cannot arise — so
// a throw cleanly means "dead".
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Scan `dir` for `<pid>.json` files and build sessionId → status. Keeps only
 * `kind === "interactive"` entries with a live pid and a known `status`. On
 * duplicate sessionId, newest `updatedAt` wins. Pure on `dir` for tests.
 */
export async function loadNativeStatuses(
  dir: string = DEFAULT_DIR,
): Promise<Map<string, SessionStatus>> {
  const result = new Map<string, SessionStatus>();
  const updatedAtBySession = new Map<string, number>();
  try {
    for await (const file of new Glob("*.json").scan({ cwd: dir, absolute: true })) {
      try {
        const raw = await Bun.file(file).text();
        const parsed = JSON.parse(raw);
        if (parsed?.kind !== "interactive") continue;
        const sessionId = parsed?.sessionId;
        if (typeof sessionId !== "string" || !sessionId) continue;
        const status = mapStatus(parsed?.status);
        if (!status) continue;
        if (!pidAlive(parsed?.pid)) continue;

        const updatedAt = typeof parsed?.updatedAt === "number" ? parsed.updatedAt : 0;
        const prev = updatedAtBySession.get(sessionId);
        if (prev !== undefined && prev >= updatedAt) continue;
        updatedAtBySession.set(sessionId, updatedAt);
        result.set(sessionId, status);
      } catch {
        // Malformed/unreadable file — skip without poisoning other entries.
      }
    }
  } catch {
    // Missing dir or scan failure — return whatever we have (empty).
  }
  return result;
}

// Short module-level TTL cache keyed off the default dir so one refresh cycle's
// per-pane lookups collapse into a single scan.
const TTL_MS = 1000;
let cache: Map<string, SessionStatus> | null = null;
let cacheAt = 0;

/**
 * Native status for a single session, or null when absent (older Claude,
 * non-interactive, dead pid, unknown status, or the brief pre-write window).
 * Callers fall back to event ?? scraper on null.
 */
export async function nativeStatus(sessionId: string): Promise<SessionStatus | null> {
  const now = Date.now();
  if (!cache || now - cacheAt > TTL_MS) {
    cache = await loadNativeStatuses();
    cacheAt = now;
  }
  return cache.get(sessionId) ?? null;
}
