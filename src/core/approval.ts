/**
 * Approval IPC (Inc6) — the consumer side of the attach-aware blocking PreToolUse
 * hook.
 *
 * When a tool needs permission on a DETACHED session, `pretooluse.sh` writes
 * `pending/<sessionId>.json` and block-polls `decisions/<sessionId>.json`.
 * `decideApproval` writes that decision file; the hook reads it and returns the
 * permission decision to Claude. Attached desk sessions never block (the hook
 * exits neutral), so only detached sessions appear in `listPendingApprovals`.
 *
 * Sync (matching the contract `void` signatures); these files are tiny.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { PATHS } from "./config";
import { readEvents, EVENTS_DIR } from "./hook-events";
import type { PendingApproval } from "../types";

export const PENDING_DIR = `${PATHS.dir}/pending`;
export const DECISIONS_DIR = `${PATHS.dir}/decisions`;

/** All sessions blocked on a detached approval (globs `pending/*.json`). */
export function listPendingApprovals(): PendingApproval[] {
  let files: string[];
  try {
    files = readdirSync(PENDING_DIR);
  } catch {
    return []; // dir not created yet
  }

  const out: PendingApproval[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(readFileSync(`${PENDING_DIR}/${f}`, "utf8"));
      const sessionId: string = raw.sessionId ?? f.replace(/\.json$/, "");
      // The shell writes a minimal record; enrich `input` from the logged
      // PreToolUse event (full tool_input is already in the event log).
      let input = raw.input;
      if (input === undefined) {
        const pre = readEvents(sessionId)
          .filter((e) => e.hook_event_name === "PreToolUse" && e.tool_use_id === raw.tool_use_id)
          .pop();
        input = pre?.tool_input;
      }
      out.push({
        sessionId,
        ts: raw.ts ?? 0,
        tool: raw.tool ?? "",
        tool_use_id: raw.tool_use_id ?? "",
        input,
      });
    } catch {
      continue; // corrupt/half-written — skip
    }
  }
  return out;
}

/**
 * Garbage-collect on-disk session files (`events/`, `pending/`, `decisions/`)
 * whose `<session_id>` has no live tmux pane (Inc7 rotation, data-model §7).
 * `liveSessionIds` is the pane↔session liveness already computed during discovery
 * — reuse it, don't add a scan. Reaps zombie approvals from a killed-mid-block
 * pane and unbounded dead-session logs.
 */
export function reapDeadSessionFiles(liveSessionIds: Set<string>): void {
  for (const dir of [EVENTS_DIR, PENDING_DIR, DECISIONS_DIR]) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue; // dir not created yet
    }
    for (const f of files) {
      // Only reap finished session files. In-flight temp files (e.g. the Stop
      // hook's `<id>.jsonl.tmp` during an atomic log-trim) must be left alone —
      // deleting one mid-rename makes the hook's `mv` fail with ENOENT.
      const m = f.match(/^(.*)\.(jsonl|json)$/);
      if (!m) continue;
      const sessionId = m[1];
      if (!liveSessionIds.has(sessionId)) {
        try {
          rmSync(`${dir}/${f}`);
        } catch {
          // already gone / racing another reaper — fine
        }
      }
    }
  }
}

/**
 * Resolve a pending approval. Writes `decisions/<sessionId>.json`; the blocking
 * hook polls it (every 500ms) and maps `decision` to `permissionDecision`.
 */
export function decideApproval(
  sessionId: string,
  decision: "allow" | "deny",
  reason?: string,
): void {
  try {
    mkdirSync(DECISIONS_DIR, { recursive: true });
    const payload: Record<string, unknown> = { sessionId, decision, ts: Date.now() };
    if (reason) payload.reason = reason;
    writeFileSync(`${DECISIONS_DIR}/${sessionId}.json`, JSON.stringify(payload));
  } catch {
    // Non-fatal — the hook's 600s timeout falls through to the desk TUI prompt.
  }
}
