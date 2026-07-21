/**
 * Per-session input-source attribution (portkey push notifications).
 *
 * The bridge's mutating routes call `markPortkeySource` on a successful action,
 * writing `source/<sessionId>.json`. At notification-dispatch time the monitor
 * calls `sourceForSession` to decide whether the most recent input on a session
 * came from portkey (→ push) or the Mac TUI (→ stay silent).
 *
 * Attribution anchors on values INTRINSIC to the hook events — a
 * `UserPromptSubmit`'s `prompt_id` (current-turn identity) and the sent message
 * `text`. Both survive `event.sh`'s `tail -200` log truncation: no absolute
 * indices, no timestamps. A turn scrolled out of the window fails to `"tui"`
 * (missed push — the tolerable direction), never a stuck `"portkey"`.
 *
 * The `.json` extension is deliberate: the GC regex in `approval.ts`
 * (`reapDeadSessionFiles`) matches `<id>.json` and reaps dead-session markers
 * with no regex change.
 */

import { writeFileSync, readFileSync, renameSync, mkdirSync } from "node:fs";
import { PATHS } from "./config";
import { readEvents } from "./hook-events";

export const SOURCE_DIR = `${PATHS.dir}/source`;

interface SourceMarker {
  turnPromptId?: string;
  text?: string;
}

function markerPath(sessionId: string): string {
  return `${SOURCE_DIR}/${sessionId}.json`;
}

/**
 * Record that portkey drove this session. Message/rewind routes pass `text` (the sent
 * message); answer/decision routes pass nothing. BOTH anchors are always written when
 * available: a message sent while the session is mid-turn is queued and — when consumed
 * inside a tool loop — never fires its own `UserPromptSubmit`, so the text alone would
 * never match and the turn-complete push would be wrongly suppressed. The still-current
 * turn's `prompt_id` covers that case; the text covers the turn-end dequeue (a NEW
 * prompt whose text is ours). Atomic (`.tmp`→rename) so a concurrent reader never sees
 * a half-written file. Non-fatal on error.
 */
export function markPortkeySource(sessionId: string, text?: string): void {
  try {
    mkdirSync(SOURCE_DIR, { recursive: true });
    const marker: SourceMarker = {};
    if (text != null) marker.text = text;
    const events = readEvents(sessionId);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.hook_event_name === "UserPromptSubmit" && events[i]!.prompt_id) {
        marker.turnPromptId = events[i]!.prompt_id;
        break;
      }
    }
    const tmp = `${markerPath(sessionId)}.tmp`;
    writeFileSync(tmp, JSON.stringify(marker));
    renameSync(tmp, markerPath(sessionId));
  } catch {
    // Non-fatal — a missed marker just means no push for this action.
  }
}

/**
 * Whether the most recent input on this session came from portkey. No marker ⇒
 * `"tui"`. Matches when the current turn's `UserPromptSubmit` was the portkey
 * message (text-match) OR portkey acted inside that still-current turn
 * (`prompt_id`-match). A newer turn (different prompt/prompt_id) shadows the
 * marker ⇒ `"tui"`.
 */
export function sourceForSession(sessionId: string): "portkey" | "tui" {
  let marker: SourceMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath(sessionId), "utf8")) as SourceMarker;
  } catch {
    return "tui"; // no marker (fresh / TUI-only session)
  }

  const events = readEvents(sessionId);
  let lastUps: { prompt?: string; prompt_id?: string } | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.hook_event_name === "UserPromptSubmit") {
      lastUps = events[i]!;
      break;
    }
  }

  if (marker.text != null && lastUps?.prompt?.trim() === marker.text.trim()) return "portkey";
  if (marker.turnPromptId != null && lastUps?.prompt_id === marker.turnPromptId) return "portkey";
  return "tui";
}
