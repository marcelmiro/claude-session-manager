/**
 * Cross-process "is this session waiting on a background script?" verdicts for the
 * monitor's ⏳ window prefix. The monitor is a fresh process per tmux status tick,
 * so the in-process caches in background-tasks.ts never survive between ticks —
 * this persists both the per-transcript parse (keyed by size+mtime) and the
 * runner-liveness verdicts to disk. The long-lived TUI uses `pendingScriptsAt`
 * directly and never touches this file.
 *
 * Steady-state cost per tick: one stat per candidate session; one lsof per
 * script-waiting session every ~15s. A full transcript read only happens when a
 * candidate's transcript mtime changes.
 */
import { parseBackgroundTasks, pendingScripts, runnerAlive } from "./background-tasks";
import { resolveTranscriptPath } from "./last-turn";
import { PATHS } from "./config";

const CACHE_PATH = `${PATHS.dir}/script-wait.json`;
const ALIVE_TTL_MS = 15_000;

export interface ScriptWaitEntry {
  size: number;
  mtimeMs: number;
  /** Pending scripts per the transcript: identity + probe target only. */
  pending: Array<{ key: string; outputPath?: string }>;
  /** Liveness by task key — dead is terminal, alive re-probes after the TTL. */
  verdicts: Record<string, { ts: number; alive: boolean }>;
}

type ScriptWaitCache = Record<string, ScriptWaitEntry>;

async function loadCache(): Promise<ScriptWaitCache> {
  try {
    return JSON.parse(await Bun.file(CACHE_PATH).text());
  } catch {
    return {};
  }
}

async function saveCache(cache: ScriptWaitCache): Promise<void> {
  try {
    await Bun.write(CACHE_PATH, JSON.stringify(cache));
  } catch {}
}

/**
 * Whether an entry's session still waits on a script, probing/refreshing verdicts
 * in place. A task without an outputPath can't be probed and counts as waiting
 * (same posture as `liveScripts`). Returns the verdict + whether verdicts changed.
 */
export async function evaluateEntry(
  entry: ScriptWaitEntry,
  now: number,
  probe: (outputPath: string) => Promise<boolean>,
): Promise<{ waiting: boolean; changed: boolean }> {
  let waiting = false;
  let changed = false;
  for (const t of entry.pending) {
    if (!t.outputPath) {
      waiting = true;
      continue;
    }
    const v = entry.verdicts[t.key];
    let alive: boolean;
    if (v && (!v.alive || now - v.ts < ALIVE_TTL_MS)) {
      alive = v.alive;
    } else {
      alive = await probe(t.outputPath);
      entry.verdicts[t.key] = { ts: now, alive };
      changed = true;
    }
    if (alive) waiting = true;
  }
  return { waiting, changed };
}

/**
 * The subset of `sessionIds` still waiting on a live background script. Reads and
 * rewrites the persisted cache; entries for ids not passed this call are pruned,
 * so the file only ever tracks the monitor's current candidates.
 */
export async function detectScriptWaits(
  sessionIds: string[],
  probe: (outputPath: string) => Promise<boolean> = runnerAlive,
): Promise<Set<string>> {
  const cache = await loadCache();
  const next: ScriptWaitCache = {};
  const out = new Set<string>();
  let dirty = false;

  for (const id of sessionIds) {
    try {
      const path = await resolveTranscriptPath(id);
      if (!path) continue;
      const stat = await Bun.file(path).stat();
      if (!stat) continue;
      let entry = cache[id];
      if (!entry || entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs) {
        const tasks = parseBackgroundTasks(await Bun.file(path).text());
        entry = {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          pending: pendingScripts(tasks).map((t) => ({
            key: t.taskId ?? t.toolUseId,
            outputPath: t.outputPath,
          })),
          // Keep prior verdicts — a transcript append doesn't revive a dead runner.
          verdicts: entry?.verdicts ?? {},
        };
        dirty = true;
      }
      const { waiting, changed } = await evaluateEntry(entry, Date.now(), probe);
      if (waiting) out.add(id);
      if (changed) dirty = true;
      next[id] = entry;
    } catch {
      // unreadable transcript — no verdict, no ⏳
    }
  }

  if (dirty || Object.keys(next).length !== Object.keys(cache).length) {
    await saveCache(next);
  }
  return out;
}
