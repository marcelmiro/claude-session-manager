// CSM mobile bridge UI — Preact + signals + htm, no build step. Auth is the
// HttpOnly `csm` cookie (set by POST /auth); this file never touches the token
// after the one login POST, and never puts it in a URL.
import { h, render } from "preact";
import { useRef, useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";
import { Marked } from "marked";
// Same module the TUI uses (core/status.ts imports it directly), served unbuilt.
import { formatTimeAgo } from "/time-ago.js";
// Unified-patch parser, served unbuilt and covered by shared/diff-lines.test.ts.
import { parseDiffLines, narrowIndent } from "/diff-lines.js";

const html = htm.bind(h);

// Render assistant markdown the way the native terminal does: real paragraphs, list
// spacing, and soft line breaks (`breaks: true` turns single newlines into <br>).
// marked has no sanitizer, so neutralize raw HTML by escaping any html token (code
// blocks are escaped correctly by marked itself), then defang javascript: links.
// Safe enough for this trusted, tailnet-only single-user bridge.
const escapeHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const marked = new Marked({ gfm: true, breaks: true });
marked.use({
  renderer: { html: (token) => escapeHtml(typeof token === "string" ? token : token.text) },
});
// Cache rendered HTML by source text. Transcript turns are immutable history, so with
// the full (unsliced) conversation rendered, this keeps SSE re-renders cheap — only
// genuinely new turns run through marked.
const mdCache = new Map();
function md(text) {
  let out = mdCache.get(text);
  if (out === undefined) {
    out = marked.parse(text).replace(/href="javascript:[^"]*"/gi, 'href="#"');
    mdCache.set(text, out);
  }
  return out;
}

const authed = signal(false);
const sessions = signal([]);
const selectedId = signal(null);
const transcript = signal(null);
const error = signal("");
const showArchived = signal(false);
const flash = signal(""); // transient FAILURE feedback in the detail view (successes stay silent)
const copied = signal(false); // transient "✓ copied" pill (clipboard success needs visible feedback)
const pendingSends = signal([]); // optimistic user bubbles awaiting transcript catch-up
const showNewSession = signal(false); // repo picker for launching a new session
const repos = signal(null); // null = loading, [] = loaded
const launching = signal(""); // repo name while waiting for a just-launched session to register
const restoring = signal(false); // true while a /restore request is in flight (blocks the button)
const menuText = signal(null); // long-pressed user message → action sheet (null = closed)
const sessionMenu = signal(null); // long-pressed session ROW → session action sheet (null = closed)
const configSheet = signal(null); // /model or /effort → model/effort selection sheet ({kind} | null)
const notice = signal(""); // transient SUCCESS notice, e.g. Claude's model/effort confirmation line
const loadingAuth = signal(true); // boot-time auth check + initial session load
const attachments = signal([]); // images staged in the composer: {blob, url} (object URLs)
const pendingImageSends = signal([]); // optimistic image bubbles awaiting transcript catch-up: {text, urls}
const connected = signal(true); // SSE stream health — false shows a "reconnecting" banner
const showAgents = signal(false); // subagent-list sheet open over the detail
const openSubagent = signal(null); // drilled-in agent {agentId, description, agentType, siblings:[]} | null
const subTranscript = signal(null); // the open subagent's conversation {turns} | null
const diffView = signal(null); // {path} → single-file diff pushed over the detail (null = closed)
const filesView = signal(false); // full changed-files list pushed over the detail
// Clock driving the relative-age labels. Ages used to recompute only when a refetch
// replaced `sessions`, so on a quiet list a row sat at "2m" for an hour. Ticking a
// signal re-renders them on their own; paused while hidden and resynced on resume.
const tick = signal(Date.now());

// File-editing tools, shared by the rewind-checkpoint calc (canCode) and the diff chips.
// Diff chips gate additionally on an edited path — `file_path` for most, `notebook_path`
// for NotebookEdit.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** The path a tool_use chip edited, whichever field carries it. */
const editedPath = (input) => input.file_path || input.notebook_path || "";
// A whole-line bracketed user turn (e.g. "[Request interrupted by user for tool use]") is a
// system notice Claude appends on interrupt — not a typed message. It's shown as a dim event
// line, and Claude's /rewind picker never lists it as a checkpoint. Mirrors preview-pane.ts.
const isSystemMarkerText = (t) => /^\[.*\]$/.test((t || "").trim());
const turnMarkerText = (turn) => {
  const c = turn.content || [];
  return c.length === 1 && c[0].type === "text" && isSystemMarkerText(c[0].text) ? c[0].text : null;
};

// A real typed prompt — a `user` turn carrying text or an image (excluding the system marker
// above). Claude records tool results as `user` turns too (content is a lone `tool_result`
// block), but those are NOT checkpoints in the /rewind picker and render as nothing in the
// thread. The rewind `upCount` walk must count ONLY prompt turns, or every tool result /
// interrupt marker inflates the count and the picker cursor overshoots → the server aborts
// with rewind-mismatch.
// `queued` turns (messages consumed from the input queue mid-turn) are excluded too:
// Claude's /rewind picker does not list them, so counting one would shift every earlier
// prompt's upCount by one.
const isPromptTurn = (turn) =>
  turn.role === "user" &&
  !turn.queued &&
  !turnMarkerText(turn) &&
  (turn.content || []).some((b) => b.type === "text" || b.type === "image");

// Ordered turn indices that are actual /rewind CHECKPOINTS. A typed prompt only becomes a
// checkpoint once it starts producing output — i.e. an assistant turn follows it before the
// next prompt. A prompt interrupted before its first token (double-tap Stop right after
// sending) creates NO checkpoint and is absent from Claude's picker, so counting it would
// shift every earlier prompt's upCount by one → the picker cursor lands wrong → the server
// aborts with rewind-mismatch. Verified against claude 2.1.x's picker. Non-prompt user turns
// (tool_result, interrupt markers) sit between and are simply skipped, not treated as prompts.
function promptCheckpointIndices(turns) {
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    if (!isPromptTurn(turns[i])) continue;
    let started = false;
    for (let j = i + 1; j < turns.length; j++) {
      if (isPromptTurn(turns[j])) break; // reached the next prompt with no output in between
      if (turns[j].role === "assistant") {
        started = true;
        break;
      }
    }
    if (started) out.push(i);
  }
  return out;
}

// Map each checkpoint's turn index → its upCount (Up-presses from "(current)": the newest
// checkpoint is 1, counting back). Non-checkpoint turns are absent (→ upCount 0, no rewind).
function upCountByIndex(turns) {
  const idx = promptCheckpointIndices(turns);
  const map = new Map();
  idx.forEach((turnIndex, pos) => map.set(turnIndex, idx.length - pos));
  return map;
}
// Optimistic rewind view: {keepTurns, rev} while a rewind is committed on-pane but not yet
// written to the JSONL (Claude's /rewind is an in-memory checkpoint until the next send, so
// the transcript still returns the abandoned branch). We truncate the displayed thread to
// `keepTurns` and hold it until the file's `rev` changes (the resend's append). null = off.
const rewindFloor = signal(null);
// One-shot composer autofill: {text, sessionId}. Set on a successful rewind to drop the
// rewound message back into the box (TUI parity); the Composer consumes and clears it.
const composerPrefill = signal(null);
// Optimistic "Chat about this": holds the sessionId whose open question we just declined,
// so the dock flips to the composer instantly (before the hook's deny resolves and the
// transcript poll drops openQuestions). Cleared on reconcile (poll shows no question), on
// failure, or by a safety timeout. null = off.
const clarifying = signal(null);
// Optimistic approve: the sessionId whose blocking APPROVAL card was just decided.
// Hides the card the instant the choice is tapped — before the POST round-trip and the
// transcript catch-up — mirroring `clarifying`. Cleared on reconcile (the refetched
// transcript no longer carries the card), on failure, or by a safety timeout. null = off.
const deciding = signal(null);
// Optimistic ANSWER for a question specifically: {id, toolUseId} of the question card
// that was just tapped. Separate from `deciding` (which stays sessionId-shaped for
// approvals) because a question needs identity: the card only stays hidden while the
// SAME question is open — a different toolUseId in the payload means a new question
// arrived and its card must show. Cleared on reconcile, on failure, or by the
// post-settle verify timer in QuestionCard. null = off.
const decidingQuestion = signal(null);

let es = null;

// Last-fetched payloads per session, so re-opening a session paints instantly
// (stale-while-revalidate — the mount fetch replaces them). Bounded so a long day of
// hopping between sessions doesn't grow memory unchecked.
function boundedSet(map, key, value, max = 20) {
  map.delete(key); // re-insert → newest position
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
}
const transcriptCache = new Map(); // sessionId → last /transcript payload (open() paints it)
const changesDataCache = new Map(); // sessionId → last /changes payload (ChangesCard/FilesView)
const prDataCache = new Map(); // sessionId → last /pr payload (usePullRequest)
function cacheTranscript(id, data) {
  boundedSet(transcriptCache, id, data);
}

// Text of every user turn already in the transcript — used to retire optimistic
// bubbles once the real send lands (the transcript lags the pane by a few seconds).
function userTurnTexts(t) {
  const out = new Set();
  for (const turn of (t && t.turns) || []) {
    if (turn.role !== "user") continue;
    // Executed slash commands land with their text on `command` (content is empty) — the
    // optimistic bubble for a "/cmd args" send must retire against that, not content.
    if (turn.command) out.add(turn.command.trim());
    for (const b of turn.content || []) if (b.type === "text" && b.text) out.add(b.text.trim());
  }
  return out;
}

// Claude prefixes an image message's caption with literal "[Image #N] " markers; strip
// them so optimistic-image retirement matches our (prefix-free) caption, and so history
// renders the caption without the noise (the 🖼 chip already conveys the image).
const stripImagePrefix = (t) => String(t || "").replace(/^(?:\[Image #\d+\]\s*)+/, "");

// --- data ---------------------------------------------------------------

async function refreshSessions() {
  try {
    const r = await fetch("/sessions");
    if (r.status === 401) return (authed.value = false);
    if (!r.ok) return;
    const list = await r.json();
    if (!Array.isArray(list)) return; // malformed payload — never poison the render with it
    sessions.value = list;
    authed.value = true;
    if (error.value === "bridge unreachable") error.value = ""; // recovered — drop the banner
    // Persist for the next cold open (iOS evicts the page constantly): boot hydrates
    // from this so reopening paints the list instantly instead of a spinner.
    try {
      localStorage.setItem("csm-sessions", JSON.stringify(sessions.value));
    } catch {
      /* private mode / quota — persistence is best-effort */
    }
  } catch {
    error.value = "bridge unreachable";
  }
}

// Volatile transcript fields — everything that can change while the JSONL doesn't (hook
// events, pane scrape, per-agent files). On an `unchanged` response these are replaced
// wholesale from the fresh payload; the file-derived bulk (turns, usage, pendingScripts,
// lastPromptAt, rev) is kept from the copy we already hold.
const VOLATILE_FIELDS = [
  "approval",
  "pendingTool",
  "openQuestion",
  "openQuestions",
  "subagents",
  "statusline",
  "mode",
  "model",
  "effort",
];

async function refreshTranscript() {
  const id = selectedId.value;
  if (!id) return;
  // Offer the held file revision so an unchanged transcript comes back as a tiny
  // volatile-fields-only response instead of the full turn list.
  const heldRev = transcript.value && transcript.value.rev;
  const q = heldRev ? `?rev=${encodeURIComponent(heldRev)}` : "";
  try {
    const r = await fetch(`/sessions/${encodeURIComponent(id)}/transcript${q}`);
    if (!r.ok) return;
    let data = await r.json();
    if (id !== selectedId.value) return; // session switched mid-flight — drop stale response
    if (data.unchanged) {
      const held = transcript.value;
      if (!held || held.rev !== data.rev) return; // held copy moved on — next poll refetches full
      const merged = { ...held };
      for (const k of VOLATILE_FIELDS) {
        if (k in data) merged[k] = data[k];
        else delete merged[k]; // omitted volatile field = cleared (e.g. question resolved)
      }
      data = merged;
    }
    // The server always returns the full active conversation branch (reconstructed
    // leaf→root), so we replace rather than append — a rewind can shrink the conversation.
    transcript.value = data;
    cacheTranscript(id, data);
    // Retire the optimistic approve/answer flip once the card is actually gone from the
    // refetched transcript (the decision resolved server-side).
    if (deciding.value === id && !(data.approval || data.openQuestions || data.openQuestion)) {
      deciding.value = null;
    }
    // Retire the optimistic answer once ITS question left the payload — either resolved
    // (no question) or replaced (different toolUseId, whose card must show immediately).
    const dq = decidingQuestion.value;
    if (dq && dq.id === id) {
      const openId = data.pendingTool && data.pendingTool.toolUseId;
      const sameStillOpen = (data.openQuestions || data.openQuestion) && openId === dq.toolUseId;
      if (!sameStillOpen) decidingQuestion.value = null;
    }
    // Retire the optimistic rewind view once the transcript file actually changed on disk
    // (the resend's append bumps `rev` even for a byte-identical resend) — the real active
    // branch is now the truncated one, so stop overriding it.
    if (rewindFloor.value && data.rev !== rewindFloor.value.rev) rewindFloor.value = null;
    // Retire the optimistic "Chat about this" flip once the declined question is actually
    // gone from the transcript (the deny resolved → PostToolUse cleared openQuestions).
    if (clarifying.value === id && !(data.openQuestions || data.openQuestion)) clarifying.value = null;
    // Drop optimistic bubbles that have now materialized as real user turns — or as
    // server-confirmed queue entries (the dim queued bubble takes over from there).
    if (pendingSends.value.length) {
      const seen = userTurnTexts(transcript.value);
      for (const q of transcript.value.queuedPending || []) seen.add(q.trim());
      const remaining = pendingSends.value.filter((p) => !seen.has(p.trim()));
      if (remaining.length !== pendingSends.value.length) pendingSends.value = remaining;
    }
    // Same for optimistic image bubbles, matched on the prefix-stripped caption (an
    // image-only send has caption "" and the transcript text is just "[Image #N]" → "").
    if (pendingImageSends.value.length) {
      const seen = new Set();
      for (const turn of transcript.value.turns || []) {
        if (turn.role !== "user") continue;
        for (const b of turn.content || []) if (b.type === "text") seen.add(stripImagePrefix(b.text).trim());
      }
      const keep = [];
      for (const e of pendingImageSends.value) {
        if (seen.has(stripImagePrefix(e.text).trim())) e.urls.forEach(URL.revokeObjectURL);
        else keep.push(e);
      }
      if (keep.length !== pendingImageSends.value.length) pendingImageSends.value = keep;
    }
  } catch {
    /* keep last-known */
  }
}

// Fetch the open subagent's conversation (same {turns} shape as /transcript, rendered
// through the existing Turn). Drops a stale response if the user switched agent/session
// mid-flight; a 404 (file vanished) flashes "transcript unavailable" without crashing.
async function refreshSubagent() {
  const o = openSubagent.value;
  const id = selectedId.value;
  if (!o || !id) return;
  try {
    const r = await fetch(`/sessions/${encodeURIComponent(id)}/subagents/${encodeURIComponent(o.agentId)}`);
    if (!r.ok) return flashError("✗ transcript unavailable");
    const data = await r.json();
    if (openSubagent.value?.agentId !== o.agentId || id !== selectedId.value) return;
    subTranscript.value = data;
  } catch {
    /* keep last-known */
  }
}

// Coalesce refetch bursts: an action's eager refresh and the SSE broadcast it triggers
// land within a few hundred ms, and each fired a full /sessions + /transcript pair. The
// leading call runs immediately; calls inside the window collapse into one trailing run.
// Sites that must await a guaranteed-fresh result (login, boot) call the raw functions.
function coalesce(fn, ms = 300) {
  let last = 0;
  let timer = null;
  return () => {
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, ms - (now - last));
    }
  };
}
const refreshSessionsSoon = coalesce(refreshSessions);
const refreshTranscriptSoon = coalesce(refreshTranscript);

function connectStream() {
  if (es) es.close();
  es = new EventSource("/stream");
  // Re-snapshot on every (re)connect. EventSource reconnects on its own but never resends
  // state, so without this the list stays stale after a dropped socket reconnects.
  es.onopen = () => {
    connected.value = true;
    refreshSessions();
    if (selectedId.value) refreshTranscript();
    if (openSubagent.value) refreshSubagent();
  };
  // EventSource auto-reconnects; surface the gap so a dropped tailnet/socket isn't silent.
  es.onerror = () => {
    if (!es || es.readyState !== 1) connected.value = false;
  };
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "session-changed") {
      refreshSessionsSoon();
      if (msg.id === selectedId.value) {
        refreshTranscriptSoon(); // updates the subagent list (status flips) on the open session
        if (openSubagent.value) refreshSubagent();
      }
    }
  };
}

async function login(token) {
  error.value = "";
  loadingAuth.value = true;
  try {
    const r = await fetch("/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!r.ok) return (error.value = "wrong token");
    await refreshSessions();
    if (authed.value) connectStream();
  } catch {
    error.value = "bridge unreachable";
  } finally {
    loadingAuth.value = false;
  }
}

// Transient FAILURE feedback that auto-hides after 5s. Successes are silent (a "✓ sent"
// toast was just noise); only errors surface, so a silently-failed action isn't invisible.
let flashTimer = null;
function flashError(msg) {
  flash.value = msg;
  clearTimeout(flashTimer);
  if (msg) flashTimer = setTimeout(() => (flash.value = ""), 5000);
}

// Copy success IS worth a toast (unlike sends): the clipboard is invisible, so silent
// success leaves you unsure it worked. A brief centered "✓ copied" pill, auto-hidden.
let copiedTimer = null;
function flashCopied() {
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1100);
}

// A longer-lived success notice (vs the 1.1s copied pill) — used to surface Claude's own
// model/effort confirmation line verbatim, including the scope it reports (global vs session).
let noticeTimer = null;
function notify(msg) {
  notice.value = msg;
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => (notice.value = ""), 4500);
}

// Send an action and report ok/failure to the caller — the bridge gates
// answer/decision/message server-side and returns {ok,reason}. Failures flash; success
// is silent (the caller updates the UI optimistically).
async function action(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.ok && data.ok !== false) {
      refreshTranscriptSoon();
      refreshSessionsSoon();
      return true;
    }
    flashError(`✗ ${data.reason || r.status}`);
    return false;
  } catch {
    flashError("✗ bridge unreachable");
    return false;
  }
}

// Like action(), but returns the parsed response so callers can read extra fields (the
// /config confirmation `line`). Refreshes on success; flashes + returns null on failure.
async function actionJson(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.ok && data.ok !== false) {
      refreshTranscriptSoon();
      refreshSessionsSoon();
      return data;
    }
    flashError(`✗ ${data.reason || r.status}`);
    return null;
  } catch {
    flashError("✗ bridge unreachable");
    return null;
  }
}

// Multipart sibling of action() for image uploads — identical result handling, but lets
// the browser set the multipart boundary (no JSON content-type header).
async function actionForm(path, formData) {
  try {
    const r = await fetch(path, { method: "POST", body: formData });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.ok && data.ok !== false) {
      refreshTranscriptSoon();
      refreshSessionsSoon();
      return true;
    }
    flashError(`✗ ${data.reason || r.status}`);
    return false;
  } catch {
    flashError("✗ bridge unreachable");
    return false;
  }
}

// Downscale a picked image in-browser to ≤1568px long edge (Claude's max useful
// resolution) and JPEG-compress it — a 10MB phone photo becomes a few hundred KB. Falls
// back to the original File if the browser can't decode it. `imageOrientation:"from-image"`
// honours EXIF rotation so portrait photos don't arrive sideways.
async function downscale(file, maxEdge = 1568, quality = 0.85) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
    return blob || file;
  } catch {
    return file;
  }
}

// Drop all staged + in-flight image object URLs (free memory) when leaving a session.
function clearAttachments() {
  for (const a of attachments.value) URL.revokeObjectURL(a.url);
  for (const e of pendingImageSends.value) e.urls.forEach(URL.revokeObjectURL);
  attachments.value = [];
  pendingImageSends.value = [];
}

function open(id) {
  selectedId.value = id;
  // Paint the last-fetched copy instantly (stale-while-revalidate) instead of blanking
  // to "loading…"; the refetch below replaces it. First-ever open still shows loading.
  transcript.value = transcriptCache.get(id) ?? null;
  flash.value = ""; // drop any stale error from the previously-open session
  pendingSends.value = [];
  rewindFloor.value = null; // never carry an optimistic rewind across sessions
  composerPrefill.value = null;
  closeAgents(); // drop any agent list/drill-in from the previously-open session
  diffView.value = null; // drop any diff / changed-files view from the previous session
  filesView.value = false;
  clearAttachments();
  refreshTranscript();
  markRead(id);
}

// Drill into one subagent: stash the row (+ siblings, for the footer prev/next nav),
// close the list sheet, then fetch its conversation.
function openAgent(agent, siblings) {
  openSubagent.value = {
    agentId: agent.agentId,
    description: agent.description,
    agentType: agent.agentType,
    siblings,
  };
  showAgents.value = false;
  subTranscript.value = null;
  refreshSubagent();
}

// Clear the agent list sheet + any open drill-in (back to the session detail).
function closeAgents() {
  showAgents.value = false;
  openSubagent.value = null;
  subTranscript.value = null;
}

// Back chevron from a drill-in → return to the session detail (the list sheet is already
// dismissed once you've drilled in).
function closeSubagent() {
  openSubagent.value = null;
  subTranscript.value = null;
}

// Reading a session clears its unread glow — but only after a 3s grace period, never
// instantly. The delay closes a race: the monitor sets ⚡ once, on the running→ready
// transition, so if Claude finishes right as you open (or glance and leave), an
// immediate read would clobber that fresh ⚡ before it reaches the phone and you'd miss
// the completion. We clear only if the session is still unread with the SAME `modified`
// we saw at open — a turn completing within the window advances `modified`, so its ⚡
// survives. Clears locally + on the bridge (which writes needsAttention:false to
// state.json so the Mac's ⚡ clears too).
const readTimers = new Map();
function markRead(id) {
  const s = sessions.value.find((x) => x.id === id);
  if (!s || !s.unread) return;
  const seen = s.modified;
  clearTimeout(readTimers.get(id));
  readTimers.set(
    id,
    setTimeout(() => {
      readTimers.delete(id);
      const cur = sessions.value.find((x) => x.id === id);
      if (!cur || !cur.unread || cur.modified !== seen) return; // gone, or a fresh turn arrived → keep ⚡
      sessions.value = sessions.value.map((x) => (x.id === id ? { ...x, unread: false } : x));
      fetch(`/sessions/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
    }, 3000),
  );
}

function back() {
  selectedId.value = null;
  transcript.value = null;
  pendingSends.value = [];
  rewindFloor.value = null;
  composerPrefill.value = null;
  closeAgents();
  clearAttachments();
}

// --- new session (repo picker → launch claude in a new tmux window) ---
async function openNewSession() {
  showNewSession.value = true;
  repos.value = null;
  try {
    const r = await fetch("/repos");
    repos.value = r.ok ? await r.json() : [];
  } catch {
    repos.value = [];
  }
}
async function launchSession(repo) {
  // The /sessions/new request blocks until claude boots and its SessionStart hook
  // registers the new session id (~1-4s), so show a "launching…" hint meanwhile, then
  // open exactly that session — server-determined id, no fragile before/after diffing.
  error.value = "";
  showNewSession.value = false;
  launching.value = repo.name;
  try {
    const r = await fetch("/sessions/new", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: repo.path, name: repo.name }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok !== false) {
      await refreshSessions();
      if (data.sessionId) open(data.sessionId);
    } else {
      error.value = `launch failed: ${data.reason || r.status}`;
    }
  } catch {
    error.value = "bridge unreachable";
  } finally {
    launching.value = "";
  }
}
// Resume an archived session from the phone. The request BLOCKS until Claude's prompt is live
// (~7-12s), so show a "Restoring…" state meanwhile; on success the session is now live
// (non-archived) and refreshSessions() flips the dock to the composer. Failures stay archived
// so the button remains for retry — the reason is surfaced via `flash` in the restore row.
async function restoreSession() {
  const id = selectedId.value;
  if (!id || restoring.value) return;
  restoring.value = true;
  flash.value = "";
  try {
    const r = await fetch(`/sessions/${encodeURIComponent(id)}/restore`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok !== false) {
      await refreshSessions();
      if (id === selectedId.value) await refreshTranscript();
    } else {
      flash.value = `restore failed: ${data.reason || r.status}`;
    }
  } catch {
    flash.value = "bridge unreachable";
  } finally {
    restoring.value = false;
  }
}

// Copy that works on iPhone across origins. On a secure origin (HTTPS) the native Clipboard
// API actually writes; over plain http navigator.clipboard is undefined, so we fall back to
// an execCommand path (see legacyCopy). iOS only honors the clipboard at all over HTTPS.
async function copyText(text) {
  if (!text) return false;
  let ok = false;
  // Prefer the native Clipboard API on a secure origin (HTTPS) — it actually writes. iOS
  // `execCommand` returns true even when it no-ops, so it can't be trusted as the primary.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) ok = legacyCopy(text); // non-secure origins / older browsers (http desktop)
  if (ok) flashCopied();
  else flashError("✗ copy failed");
  return ok;
}

// Copy from an action sheet: copy, then dismiss the sheet.
async function copyMessage(text) {
  await copyText(text);
  menuText.value = null;
}

// execCommand("copy") via an off-screen field — the only path on a non-secure origin
// (plain http over Tailscale), where navigator.clipboard is undefined. The iOS recipe
// (per clipboard.js): a `readonly` textarea (so no keyboard pops up), positioned off-screen
// rather than hidden via opacity:0 (iOS won't copy from a zero-opacity element), selected
// with BOTH a Range over the node AND setSelectionRange. 16px font avoids an iOS zoom jump.
function legacyCopy(text) {
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.cssText = `position:absolute;left:-9999px;top:${window.scrollY || 0}px;font-size:16px;`;
    document.body.appendChild(el);
    const prior = document.getSelection().rangeCount > 0 ? document.getSelection().getRangeAt(0) : null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    if (prior) {
      sel.removeAllRanges();
      sel.addRange(prior); // restore whatever the user had selected
    }
    return ok;
  } catch {
    return false;
  }
}

// Long-press detection for message actions. A single shared timer (only one press at a
// time); a move or release before the threshold cancels it, so it never fights swipes.
// The menu payload carries the message text + its rewind target (upCount = Up-presses from
// "(current)" in Claude's /rewind picker; 0 = not a checkpoint, so no rewind — see
// upCountByIndex). canCode gates the code-restore option.
let lpTimer = null;
const lpStart = (text, upCount, canCode) => () => {
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => (menuText.value = { text, upCount, canCode }), 450);
};
const lpCancel = () => clearTimeout(lpTimer);

// Assistant bubble: long-press → a Copy-only sheet (rewind is a user-turn concept). The
// `assistant` flag tells ActionSheet to drop the rewind buttons. `asstLpFired` suppresses the
// click iOS fires on release so a long-press never also tap-copies a code span underneath it.
let asstLpFired = false;
const lpStartAsst = (text) => () => {
  asstLpFired = false;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    asstLpFired = true;
    menuText.value = { text, assistant: true };
  }, 450);
};

// Tap-to-copy inside a rendered-markdown assistant bubble: a tap on a code block copies the
// whole block, a tap on an inline `code` span copies just that span. Non-code taps do nothing
// (the bubble isn't natively selectable). Delegation over the marked-generated HTML — no need
// to attach handlers to injected nodes.
function assistantTap(e) {
  if (asstLpFired) {
    asstLpFired = false;
    return; // this click is the tail of a long-press that already opened the sheet
  }
  const target = e.target.closest("pre") || e.target.closest("code");
  if (!target) return;
  e.preventDefault();
  copyText(target.textContent);
}

// Turn index of the checkpoint `upCount` Up-presses from current (the inverse of the render's
// upCountByIndex map) — i.e. where a rewind-to-before-it truncates the thread. -1 if not found
// (stale menu / count drift), signalling "don't truncate".
function keepTurnsForUpCount(turns, upCount) {
  for (const [turnIndex, up] of upCountByIndex(turns)) {
    if (up === upCount) return turnIndex;
  }
  return -1;
}

async function rewind(mode) {
  const m = menuText.value;
  menuText.value = null;
  if (!m) return;
  // Snapshot BEFORE the await: the target's truncation point + the transcript's current disk
  // revision. Rewind is offered only at the prompt (idle), so the tail is stable here.
  const sid = selectedId.value;
  const t = transcript.value;
  const keepTurns = t && t.turns ? keepTurnsForUpCount(t.turns, m.upCount) : -1;
  const rev0 = t ? t.rev : undefined;
  const ok = await action(`/sessions/${encodeURIComponent(sid)}/rewind`, {
    upCount: m.upCount,
    text: m.text,
    mode,
  });
  if (!ok || sid !== selectedId.value) return; // failed (action flashed) or switched away
  if (keepTurns >= 0) rewindFloor.value = { keepTurns, rev: rev0 };
  composerPrefill.value = { text: m.text, sessionId: sid };
}

// Long-press on a session ROW opens the session action sheet (archive). Shares the
// single lpTimer (one press at a time). lpFired suppresses the tap-to-open click that
// iOS fires on release, so a long-press never also navigates into the session.
let lpFired = false;
function rowPress(s) {
  return {
    onPointerDown: () => {
      lpFired = false;
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        lpFired = true;
        sessionMenu.value = s;
        if (navigator.vibrate) navigator.vibrate(8); // a tap of haptic feedback, like iOS
      }, 450);
    },
    onPointerUp: lpCancel,
    onPointerMove: lpCancel,
    onPointerCancel: lpCancel,
    onClick: (e) => {
      if (lpFired) {
        e.preventDefault();
        lpFired = false;
        return;
      }
      open(s.id);
    },
  };
}

async function archiveSession() {
  const s = sessionMenu.value;
  sessionMenu.value = null;
  if (!s) return;
  // If we're viewing the session we just archived, drop back to the list.
  if (selectedId.value === s.id) selectedId.value = null;
  await action(`/sessions/${encodeURIComponent(s.id)}/archive`, {});
}

// --- views --------------------------------------------------------------

const DOT = { waiting: "⏸", running: "⦿", ready: "●", idle: "○", archived: "○" };
const DOT_COLOR = {
  waiting: "var(--red)",
  running: "var(--mint)",
  ready: "var(--peach)",
  idle: "var(--dim)",
  archived: "var(--dim)",
};
const RANK = { waiting: 0, running: 1, ready: 2, idle: 3, archived: 4 };
const GENERIC_BRANCH = new Set(["main", "master", "develop", "dev", ""]);

// Status indicator as a uniform CSS circle (identical size for every status, unlike the
// mismatched ⏸/⦿/●/○ glyphs): filled disc for active states, hollow ring for idle/archived.
// An UNREAD session (monitor's ⚡ — a completed turn or a block you haven't seen on Mac or
// phone yet) gets a glow ring in its status color, so "glow = go read" at a glance. The
// glow clears the moment you open it (here and, via the bridge, on the Mac too).
const GLOW = {
  waiting: "rgba(255,128,128,0.65)",
  running: "rgba(153,255,228,0.6)",
  ready: "rgba(255,199,153,0.62)",
  idle: "rgba(180,180,180,0.55)",
  archived: "rgba(180,180,180,0.55)",
};
function dotStyle(s) {
  // Blocked-ON-YOU (pending question/approval) is the loudest state: a red disc with a
  // red halo, regardless of the raw status (a question session often reports `ready`).
  if (s.pending) {
    const r = GLOW.waiting;
    return `background:var(--red);box-shadow:0 0 0 4px ${r}, 0 0 9px 2px ${r}`;
  }
  const color = DOT_COLOR[s.status] ?? "var(--dim)";
  const ring = s.status === "idle" || s.status === "archived";
  const base = ring ? `border:1.5px solid ${color}` : `background:${color}`;
  const g = GLOW[s.status] ?? "rgba(255,255,255,0.55)";
  // Firmer ring + a soft blurred halo so unread reads at a glance (not just a faint tint).
  return s.unread ? `${base};box-shadow:0 0 0 4px ${g}, 0 0 9px 2px ${g}` : base;
}

// Fixed repo group order so the list doesn't reshuffle as session statuses change.
// Listed repos pin to the top in this order; everything else follows alphabetically.
const REPO_ORDER = ["throxy", "customeros", "~", "csm"];
function repoRank(repo) {
  const i = REPO_ORDER.indexOf(repo);
  return i === -1 ? REPO_ORDER.length : i;
}

// A raw filesystem path or a generic branch is noise as a subtitle — drop it so the
// row falls back to nothing (cleaner) rather than echoing "/tmp/…md" or "main".
function isNoisySub(t) {
  return /^[~/]/.test(t) || /\/[^\s/]+\/[^\s/]+/.test(t) || GENERIC_BRANCH.has(t);
}
// Slug for comparing a branch against the row title — lowercased, non-alnum → hyphen.
function slug(x) {
  return (x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// Secondary line: a meaningful summary if we have one; otherwise a real branch name.
// Never a filesystem path, a generic branch ("main"), a repeat of the title, or a branch
// that merely echoes the name ("add-tomba" / "add-tomba-as-enrichment-provider") — all
// noise, so the row falls back to just the name (cleaner than echoing junk).
function subLine(s) {
  const sum = (s.summary || "").replace(/\s+/g, " ").trim();
  if (sum && sum !== listTitle(s) && !isNoisySub(sum)) return sum;
  if (GENERIC_BRANCH.has(s.branch)) return "";
  const name = slug(listTitle(s));
  const branch = slug(s.branch);
  if (name && (branch === name || branch.startsWith(name + "-"))) return "";
  return s.branch;
}

function modifiedMs(s) {
  // Same source as the displayed age (last conversational turn), so the order matches
  // what the rows read rather than following file-mtime noise.
  const t = activityAt(s) ? new Date(activityAt(s)).getTime() : NaN;
  return Number.isFinite(t) ? t : 0; // unknown recency → oldest → bottom
}

// Visual top-to-bottom order shared by the list AND prev/next session nav, so the
// chevrons/swipes move through sessions exactly as they're stacked. Priority first
// (blocked, then status rank), then most-recently-used; older sessions sink to the
// bottom. Repo grouping (List) keys off first appearance, so groups inherit this
// order via their top session. The current session is kept even if archived-filtered.
function compareSessions(a, b) {
  return (
    (a.unread ? 0 : 1) - (b.unread ? 0 : 1) ||
    (a.pending ? 0 : 1) - (b.pending ? 0 : 1) ||
    (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) ||
    modifiedMs(b) - modifiedMs(a)
  );
}
function orderedSessions() {
  return sessions.value
    .filter(
      (s) =>
        showArchived.value || s.status !== "archived" || s.unread || s.pending || s.id === selectedId.value,
    )
    .sort(compareSessions);
}

// Unread sessions — the "go read" queue (monitor's ⚡: completed turns + blocks).
function attentionSessions() {
  return sessions.value.filter((s) => s.unread).sort(compareSessions);
}

// Triage forward: jump to the next session needing attention (cycling past the
// current one); if none remain, fall back to the list. This — not linear up/down — is
// how you work a queue of blocked sessions from the phone.
function gotoNextAttention() {
  const queue = attentionSessions();
  const others = queue.filter((s) => s.id !== selectedId.value);
  if (others.length === 0) return back();
  const cur = queue.findIndex((s) => s.id === selectedId.value);
  const next = cur >= 0 ? queue[(cur + 1) % queue.length] : queue[0];
  open(next.id);
}

// Token-usage readout, mirroring the Mac statusline (current/size pct%), colored at
// the same 50/75% thresholds.
function usageColor(p) {
  return p > 75 ? "var(--red)" : p > 50 ? "var(--peach)" : "var(--mint)";
}

// When a session last did something. `lastTurn` is its newest conversational turn;
// `modified` (the transcript's file mtime) is the fallback — bookkeeping writes and
// bulk resumes push mtime forward with no conversation behind them, so it only stands
// in when the turn timestamp is unavailable (fixtures, or an older server).
function activityAt(s) {
  return s.lastTurn || s.modified;
}

// Concise "time since last activity" — the list column the Mac shows as token %
// (which says nothing about recency). Reading `tick` makes every age re-render on the
// clock below, not only when a refetch replaces the session list.
function formatAge(iso) {
  return formatTimeAgo(iso, { now: tick.value, verbose: true });
}

// Row title mirrors `csm list`: the tmux-style AI name (repo is the group header, so
// just the name). Falls back to the summary/branch label only when unnamed.
function listTitle(s) {
  return s.name || s.label || s.branch || s.id.slice(0, 8);
}

// Mirrors the static boot spinner in index.html exactly, so when Preact mounts and
// replaces #app the spinner doesn't visibly jump or restart mid-spin.
function Spinner() {
  return html`
    <div class="center">
      <div class="spinner"></div>
      <div class="loadtext">connecting</div>
    </div>
  `;
}

function Login() {
  let value = "";
  return html`
    <div class="center login">
      <h1 class="brand">portkey</h1>
      <div class="brandsub">enter your bridge token to connect</div>
      <input
        type="password"
        autocomplete="off"
        placeholder="bridge token"
        onInput=${(e) => (value = e.target.value)}
        onKeyDown=${(e) => e.key === "Enter" && login(value)}
      />
      <button class="primary" onClick=${() => login(value)}>Connect</button>
      ${error.value && html`<div class="err">${error.value}</div>`}
    </div>
  `;
}

function List() {
  const all = sessions.value;
  // A session blocked on a question/tool stays visible even when archived-filtered —
  // discovery can mislabel a live, blocked session as archived, and answering it is
  // exactly what the phone is for.
  const archivedCount = all.filter((s) => s.status === "archived" && !s.pending).length;
  const list = orderedSessions();
  // Blocked-ON-YOU sessions surface in a pinned section ABOVE the repo groups — fixed
  // group order otherwise buries them in a low-priority repo. "Act now" = a real pending
  // question/approval OR a `waiting` status (a y/n confirm the pending-detector missed);
  // the softer "go read" (unread) queue stays in the header chip, not this section.
  const needsYou = list.filter((s) => s.pending || s.status === "waiting");
  const needsYouIds = new Set(needsYou.map((s) => s.id));
  // Titles that recur get a short id so duplicates are distinguishable (e.g. two
  // "restore-session" rows that are otherwise identical).
  const titleCounts = {};
  for (const s of list) titleCounts[listTitle(s)] = (titleCounts[listTitle(s)] || 0) + 1;
  const renderRow = (s) => {
    const t = listTitle(s);
    // Duplicate titles (a session and its fork share a name) are otherwise identical —
    // show the short id, the only thing that distinguishes them, instead of the branch.
    const sub = titleCounts[t] > 1 ? s.id.slice(0, 8) : subLine(s);
    return html`
      <button
        type="button"
        class="row"
        key=${s.id}
        ...${rowPress(s)}
        onContextMenu=${(e) => e.preventDefault()}
      >
        <span class="dot" style=${dotStyle(s)}></span>
        <span class="grow">
          <span class="name"
            >${s.pendingScripts > 0 &&
            html`<span class="scriptmark" title="waiting on a background script">⏳</span>`}${t}</span
          >
          ${sub && html`<span class="sub">${sub}</span>`}
        </span>
        ${s.pending
          ? html`<span class="pendingbadge ${s.pending === "question" ? "q" : "a"}"
                >${s.pending === "question" ? "answer" : "approve"}</span
              ><span class="age">${formatAge(activityAt(s))}</span>`
          : html`<span class="age">${formatAge(activityAt(s))}</span>`}
      </button>`;
  };
  // Repo groups exclude the "needs you" sessions (shown in the pinned block above).
  const groups = [];
  for (const s of list) {
    if (needsYouIds.has(s.id)) continue;
    let g = groups.find((x) => x.repo === s.repo);
    if (!g) groups.push((g = { repo: s.repo, rows: [] }));
    g.rows.push(s);
  }
  // Static group order (pinned repos first, then alphabetical) so the list never
  // reshuffles when a session's status changes. Rows within a group stay sorted by
  // status/recency via orderedSessions above.
  groups.sort((a, b) => repoRank(a.repo) - repoRank(b.repo) || a.repo.localeCompare(b.repo));
  // Header counts mirror the TUI status-right (⚡ needs-attention, 🔄 running).
  // Attention = blocked-on-you + unread (unique); loud red when any session is
  // actually blocked, softer peach when it's only unseen turns. Clicking jumps
  // to the first needy session (blocked first, else oldest unread).
  const attnTotal = new Set([...needsYou.map((s) => s.id), ...attentionSessions().map((s) => s.id)]).size;
  const attnTarget = needsYou[0] || attentionSessions()[0];
  // A session waiting on a background script is churning without needing you — same
  // answer the 🔄 chip gives, so it counts there (once; no double count when also running).
  const runningCount = all.filter((s) => s.status === "running" || s.pendingScripts > 0).length;
  return html`
    <div class="screen">
      <div class="scroll">
        <div class="listhead">
          <h1>
            portkey
            ${attnTotal > 0 &&
            html`<button class="attnchip ${needsYou.length ? "" : "soft"}" onClick=${() => attnTarget && open(attnTarget.id)}>
              ⚡ ${attnTotal} ›
            </button>`}
            ${runningCount > 0 && html`<span class="runchip">🔄 ${runningCount}</span>`}
          </h1>
          <button class="newbtn" onClick=${openNewSession} aria-label="New session">+</button>
        </div>
        ${error.value && error.value !== "bridge unreachable" && html`<div class="err">${error.value}</div>`}
        ${launching.value && html`<div class="sub" style="padding:4px 4px 10px">launching ${launching.value}…</div>`}
        ${needsYou.length > 0 &&
        html`<div class="group" key="needs-you">
          <div class="repo needsyou">needs you</div>
          ${needsYou.map(renderRow)}
        </div>`}
        ${groups.map(
          (g) => html`
            <div class="group" key=${g.repo}>
              <div class="repo">${g.repo === "~" ? "home" : g.repo}</div>
              ${g.rows.map(renderRow)}
            </div>
          `,
        )}
        ${archivedCount > 0 &&
        html`<div class="btns" style="margin-top:14px">
          <button onClick=${() => (showArchived.value = !showArchived.value)}>
            ${showArchived.value ? "Hide" : "Show"} ${archivedCount} archived
          </button>
        </div>`}
      </div>
    </div>
  `;
}


// New-session repo picker: tap a base repo to launch `claude` in a new tmux window on
// its current branch; tap a nested worktree to launch there instead. Worktrees render
// indented under their base repo (the list arrives base-then-worktrees, in order).
function NewSession() {
  const list = repos.value;
  const { rootRef, onTouchStart, onTouchEnd } = useSwipeBack(() => (showNewSession.value = false));
  return html`
    <div class="screen" ref=${rootRef} onTouchStart=${onTouchStart} onTouchEnd=${onTouchEnd}>
      <div class="listhead">
        <button class="iconbtn" onClick=${() => (showNewSession.value = false)} aria-label="Back">‹</button>
        <h1 style="margin:0">new session</h1>
      </div>
      <div class="scroll">
        ${error.value && error.value !== "bridge unreachable" && html`<div class="err">${error.value}</div>`}
        ${list === null && html`<div class="sub" style="padding:8px">loading repos…</div>`}
        ${list && list.length === 0 && html`<div class="sub" style="padding:8px">no repos found</div>`}
        ${list &&
        list.map((r) => {
          // Worktree: just the branch name, indented under its base repo (left-rail + indent
          // signal the nesting — no marker, no path).
          if (r.isWorktree) {
            return html`
              <button type="button" class="row wt" key=${r.path} onClick=${() => launchSession(r)}>
                <span class="grow"><span class="name">${r.branch}</span></span>
              </button>
            `;
          }
          // Base repo (and the "~" home entry): a "+" marker + the name.
          return html`
            <button type="button" class="row" key=${r.path} onClick=${() => launchSession(r)}>
              <span class="addmark">+</span>
              <span class="grow"><span class="name">${r.name}</span></span>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

// One conversational turn → a sequence of chat elements: text blocks become
// bubbles (user right / assistant left), tool calls become compact chips, image
// attachments become a 🖼 marker; thinking and tool_result blocks are omitted.
function Turn({ turn, upCount, canCode }) {
  // Post-compaction summary: render as a labeled, full-width system divider — not a giant
  // user bubble — so it reads as "this branch continued from a compact" rather than the user
  // having pasted a wall of text. Body is collapsed by default (it's long) but kept verbatim.
  if (turn.compactSummary) {
    const text = (turn.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
    return html`<div class="turn">
      <details class="compact-summary">
        <summary>↻ Continued from compacted summary</summary>
        <div class="md" dangerouslySetInnerHTML=${{ __html: md(text) }}></div>
      </details>
    </div>`;
  }

  // An executed slash command — rendered as a normal user bubble showing exactly what was
  // typed, matching the terminal (which echoes the command as your prompt line). Not a
  // rewind checkpoint (content is empty, so isPromptTurn already excludes it), hence no
  // long-press rewind handlers.
  if (turn.command) {
    return html`<div class="turn"><div class="bubble user">${turn.command}</div></div>`;
  }

  // Interrupt / system markers ("[Request interrupted by user…]") render as a dim event
  // line, never a user bubble — they're not typed messages and aren't rewind checkpoints.
  const marker = turnMarkerText(turn);
  if (marker) {
    return html`<div class="turn"><div class="sysline">⊘ ${marker.replace(/^\[|\]$/g, "")}</div></div>`;
  }

  const role = turn.role === "user" ? "user" : "assistant";
  const els = [];
  for (const b of turn.content || []) {
    if (b.type === "image") {
      els.push(html`<div class="imgmark">🖼 image</div>`);
      continue;
    }
    // User captions arrive prefixed with literal "[Image #N]" markers — strip for display
    // (the 🖼 chip already conveys the image; keep the raw text for long-press/rewind).
    const shown = b.type === "text" ? (role === "user" ? stripImagePrefix(b.text) : b.text) : "";
    if (b.type === "text" && shown && shown.trim()) {
      // Assistant text is markdown-rendered; user text stays literal (it's what you typed).
      els.push(
        role === "assistant"
          ? html`<div
              class="bubble assistant md"
              onClick=${assistantTap}
              onTouchStart=${lpStartAsst(b.text)}
              onTouchMove=${lpCancel}
              onTouchEnd=${lpCancel}
              onContextMenu=${(e) => e.preventDefault()}
              dangerouslySetInnerHTML=${{ __html: md(shown) }}
            ></div>`
          : html`<div
              class="bubble user"
              onTouchStart=${lpStart(b.text, upCount, canCode)}
              onTouchMove=${lpCancel}
              onTouchEnd=${lpCancel}
              onContextMenu=${(e) => e.preventDefault()}
            >${shown}</div>`,
      );
    } else if (b.type === "tool_use") {
      const input = b.input || {};
      const path = editedPath(input);
      const arg = input.command || path || input.pattern || "";
      // A file-editing chip with a path is tappable → opens that file's diff. The route
      // resolves a rename's old path itself, so the chip only has to name the file.
      const tappable = EDIT_TOOLS.has(b.name) && !!path;
      els.push(
        html`<div
          class=${"tool" + (tappable ? " tap" : "")}
          onClick=${tappable ? () => (diffView.value = { path }) : undefined}
        >
          ▸ ${b.name || "tool"}${arg && html` <span class="arg">${arg}</span>`}${tappable &&
          html`<span class="tapchev">›</span>`}
        </div>`,
      );
    }
  }
  return els.length ? html`<div class="turn">${els}</div>` : null;
}

// The server's /answer takes one selection PER QUESTION (a prompt may carry several):
// each entry is a number (single-select) or number[] (multi-select), in question order.
function QuestionCard({ questions, toolUseId }) {
  // Optimistic: drop the card the instant an option is tapped — the composer takes the
  // dock immediately instead of waiting out the POST + transcript refetch. Reverts with
  // a bespoke message on failure. Raw fetch (not action(), which auto-flashes the raw
  // reason code). After a SUCCESSFUL answer there is no idle transcript poll and a
  // swallowed answer produces no SSE event, so a verify timer drives the refetch: if
  // the SAME question is still open ~8s after the server accepted, the answer didn't
  // land — re-show the card so the user can retry, instead of hiding it forever.
  // (The old blind 5s timer re-showed the card during ordinarily-slow successful
  // resolutions, inviting the double-tap this replaced.)
  const post = (selections) => {
    const id = selectedId.value;
    decidingQuestion.value = { id, toolUseId };
    const active = () => {
      const dq = decidingQuestion.value;
      return dq && dq.id === id && dq.toolUseId === toolUseId;
    };
    fetch(`/sessions/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selections, toolUseId }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (!active()) return; // reconciled or superseded while the POST was in flight
        if (d && d.ok) {
          refreshTranscriptSoon();
          refreshSessionsSoon();
          setTimeout(() => {
            if (!active()) return;
            if (selectedId.value !== id) return (decidingQuestion.value = null); // left the session
            refreshTranscript().then(() => {
              if (!active()) return; // the refetch reconciled it — answer landed
              decidingQuestion.value = null;
              flashError("✗ answer may not have landed — try again");
            });
          }, 8000);
        } else {
          decidingQuestion.value = null;
          const reason = (d && d.reason) || "answer failed";
          if (reason === "stale-question") {
            flashError("✗ question changed — refreshing");
            refreshTranscript();
          } else if (reason === "not-presented") {
            flashError("✗ couldn't reach the prompt — check the Mac");
          } else {
            flashError(`✗ ${reason}`);
          }
        }
      })
      .catch(() => {
        if (active()) decidingQuestion.value = null;
        flashError("✗ bridge unreachable");
      });
  };
  // "Chat about this": decline the whole prompt (regardless of wizard step) so the agent
  // yields and waits for a typed message. Optimistically flip to the composer + focus it;
  // a bare fetch (not action(), whose refreshTranscript would flicker the card back before
  // the deny resolves) drives the server, reverting only on failure.
  const chat = () => {
    const id = selectedId.value;
    clarifying.value = id;
    composerPrefill.value = { text: "", sessionId: id }; // focus composer → raise keyboard
    const revert = (reason) => {
      flashError(`✗ ${reason}`);
      if (clarifying.value === id) clarifying.value = null;
    };
    fetch(`/sessions/${encodeURIComponent(id)}/clarify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        // not-held = the hook holding the prompt is gone, so it's now the on-screen
        // picker, which has no "chat instead" key — say so rather than echo the code.
        if (d && d.ok === false)
          revert(d.reason === "not-held" ? "prompt moved to the desk — pick an option" : d.reason || "clarify failed");
      })
      .catch(() => revert("bridge unreachable"));
    // Safety: never leave the card hidden if the question somehow stays open.
    setTimeout(() => {
      if (clarifying.value === id) clarifying.value = null;
    }, 5000);
  };
  return html`
    <div class="qwrap">
      ${questions.length > 1
        ? html`<${MultiQuestionCard} questions=${questions} post=${post} />`
        : html`<${SingleQuestionCard} q=${questions[0]} post=${post} />`}
      <button class="chat-about" onClick=${chat}>💬 Chat about this</button>
    </div>
  `;
}

// Single question — multiSelect: accumulate a set + explicit Submit. single-select:
// tap an option to answer immediately. Options scroll in a capped card (#2).
function SingleQuestionCard({ q, post }) {
  const multi = q.multiSelect;
  const [sel, setSel] = useState(() => new Set());
  const toggle = (i) => {
    const next = new Set(sel);
    next.has(i) ? next.delete(i) : next.add(i);
    setSel(next);
  };
  return html`
    <div class="card alert qcard">
      <div class="who">question${multi ? " · select all that apply" : ""}</div>
      <div class="qtext">${q.question}</div>
      <div class="opts">
        ${q.options.map(
          (o, i) => html`
            <button
              class="opt ${multi && sel.has(i) ? "sel" : ""}"
              key=${i}
              onClick=${() => (multi ? toggle(i) : post([i]))}
            >
              <span class="opt-head">
                ${multi && html`<span class="opt-check">${sel.has(i) ? "☑" : "☐"}</span>`}
                <span class="opt-label">${o.label}</span>
              </span>
              ${o.description && html`<span class="opt-desc">${o.description}</span>`}
              ${o.preview && html`<pre class="opt-preview">${o.preview}</pre>`}
            </button>
          `,
        )}
      </div>
      ${multi &&
      html`<button
        class="opt-submit"
        disabled=${sel.size === 0}
        onClick=${() => post([[...sel].sort((a, b) => a - b)])}
      >
        Submit${sel.size ? ` (${sel.size})` : ""}
      </button>`}
    </div>
  `;
}

// Multi-question wizard — one question per screen, Back/Next, final Submit posts a
// per-question selection array. single-select = tap-to-select; multi-select = checkboxes.
// Submit needs every single-select answered (a multi-select may be left empty).
function MultiQuestionCard({ questions, post }) {
  const [step, setStep] = useState(0);
  // picks[i]: a number (single-select, null until chosen) or a Set (multi-select).
  const [picks, setPicks] = useState(() => questions.map((q) => (q.multiSelect ? new Set() : null)));
  const q = questions[step];
  const multi = q.multiSelect;
  const pick = picks[step];
  const last = step === questions.length - 1;

  const update = (next) => {
    const copy = picks.slice();
    copy[step] = next;
    setPicks(copy);
  };
  const toggle = (i) => {
    const next = new Set(pick);
    next.has(i) ? next.delete(i) : next.add(i);
    update(next);
  };
  const ready = questions.every((qq, i) => (qq.multiSelect ? true : picks[i] != null));
  const submit = () =>
    post(questions.map((qq, i) => (qq.multiSelect ? [...picks[i]].sort((a, b) => a - b) : picks[i])));

  return html`
    <div class="card alert qcard">
      <div class="who">
        question ${step + 1} of ${questions.length}${multi ? " · select all that apply" : ""}
      </div>
      <div class="qtext">${q.question}</div>
      <div class="opts">
        ${q.options.map(
          (o, i) => html`
            <button
              class="opt ${multi ? (pick.has(i) ? "sel" : "") : pick === i ? "sel" : ""}"
              key=${i}
              onClick=${() => (multi ? toggle(i) : update(i))}
            >
              <span class="opt-head">
                ${multi
                  ? html`<span class="opt-check">${pick.has(i) ? "☑" : "☐"}</span>`
                  : html`<span class="opt-check">${pick === i ? "◉" : "◯"}</span>`}
                <span class="opt-label">${o.label}</span>
              </span>
              ${o.description && html`<span class="opt-desc">${o.description}</span>`}
              ${o.preview && html`<pre class="opt-preview">${o.preview}</pre>`}
            </button>
          `,
        )}
      </div>
      <div class="qnav">
        <button class="opt-submit" disabled=${step === 0} onClick=${() => setStep(step - 1)}>
          Back
        </button>
        ${last
          ? html`<button class="opt-submit" disabled=${!ready} onClick=${submit}>Submit</button>`
          : html`<button class="opt-submit" onClick=${() => setStep(step + 1)}>Next</button>`}
      </div>
    </div>
  `;
}

// Commands that can lose data / escalate / hit the network — surfaced loudly so a
// remote, eyes-off approval isn't a same-looking tap as a harmless one.
const DESTRUCTIVE = /\b(rm\s+-[a-z]*[rf]|rmdir|git\s+(push|reset|clean)|sudo|dd\b|mkfs|chmod\s+-R|chown\s+-R|truncate|shutdown|reboot|kill(all)?)\b|>\s*\/|:\(\)\s*\{/;

function ApprovalCard({ approval }) {
  const input = approval.input || {};
  const detail = input.command || input.file_path || "";
  const risky = typeof input.command === "string" && DESTRUCTIVE.test(input.command);
  // Optimistic: clear the card on tap (Allow flips the dock to the running tool / composer
  // instantly); revert on failure, safety-timeout if the prompt somehow stays up.
  function decide(decision) {
    const id = selectedId.value;
    deciding.value = id;
    action(`/sessions/${encodeURIComponent(id)}/decision`, { decision }).then((ok) => {
      if (!ok && deciding.value === id) deciding.value = null;
    });
    setTimeout(() => {
      if (deciding.value === id) deciding.value = null;
    }, 5000);
  }
  return html`
    <div class="card alert">
      <div class="who ${risky ? "danger" : ""}">approve · ${approval.tool}</div>
      ${input.description && html`<div class="approve-desc">${input.description}</div>`}
      ${detail && html`<pre class=${risky ? "cmd-danger" : ""}>${detail}</pre>`}
      ${risky && html`<div class="risk-tag">⚠ destructive — review carefully</div>`}
      <div class="approve-btns">
        <button class="btn-deny" onClick=${() => decide("deny")}>Deny</button>
        <button class="btn-allow" onClick=${() => decide("allow")}>Allow</button>
      </div>
    </div>
  `;
}

// In-flight tool with NO decision required (e.g. auto-approved) — read-only info,
// never Allow/Deny.
function RunningTool({ tool }) {
  const detail = tool.command || tool.filePath || tool.pattern || "";
  return html`
    <div class="card">
      <div class="who">⦿ running — ${tool.name}</div>
      ${detail && html`<pre>${detail}</pre>`}
    </div>
  `;
}

// Free-text composer — available in any state (TUI parity: the bridge sends keys to
// the pane regardless of status; Claude queues input while running, accepts it at the
// prompt). Sent text shows immediately as an optimistic bubble until the transcript
// catches up. Enter sends, Shift+Enter / the multiline keyboard inserts a newline.
function Composer({ disabled, status }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const enterArmed = useRef(false); // true after a plain Enter — a second one submits
  const enterShift = useRef(false); // e.shiftKey of the latest Enter keydown
  const shiftRun = useRef(false); // inside a Shift+Enter run — suppress submit until a keystroke
  const [hasText, setHasText] = useState(false); // drives the Stop⇄Send toggle; uncontrolled textarea
  const stopArmed = useRef(false); // first Stop tap arms; a second within 3s fires (double-tap confirm)
  const disarmTimer = useRef(null);
  // Session id we just interrupted. While set AND that session still reads "running", the Stop
  // button is suppressed (Send shown) so an unrelated /sessions refetch can't flicker Stop back
  // before native status settles to ready. Cleared when the flip lands, on failure, on session
  // switch, or by a safety timeout — so it never strands the button hidden on a running turn.
  const interruptedId = useRef(null);
  const interruptTimer = useRef(null);
  // "/" slash-command menu. Kept in a ref (not state) so the once-attached native
  // beforeinput/keydown listeners below never read stale values; `rerender` repaints.
  const slash = useRef({ open: false, filtered: [], active: 0 });
  const slashCache = useRef(new Map()); // sid → fetched command list (one fetch per session)
  const [, forceRender] = useState(0);
  const rerender = () => forceRender((n) => (n + 1) & 0xffff);
  const sid = selectedId.value; // read in render so the component re-subscribes on session switch
  function grow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }
  // The textarea is uncontrolled, so hasText must be resynced at EVERY site that mutates
  // el.value — onInput fires for keystrokes, but selectSlash() and the failed-send restore
  // assign el.value directly (no native input event). Call this at all of them.
  function syncHasText() {
    const el = ref.current;
    setHasText(!!(el && el.value.trim()));
  }
  function disarmStop() {
    clearTimeout(disarmTimer.current);
    if (stopArmed.current) {
      stopArmed.current = false;
      rerender();
    }
  }
  function clearInterrupted() {
    clearTimeout(interruptTimer.current);
    interruptedId.current = null;
  }
  // Double-tap Stop: first tap arms (relabels), a second within 3s interrupts. Firing flips
  // the session's status to "ready" optimistically so the button becomes Send this frame; a
  // bare POST (not action(), which would immediately refetch and revert the optimism before
  // native settles) sends the interrupt. The server's reconciler broadcasts the real "ready"
  // ~1.5-3s later. On failure we refetch to restore the true "running" (Stop returns).
  function onStop() {
    if (!stopArmed.current) {
      stopArmed.current = true;
      rerender();
      clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(disarmStop, 3000);
      return;
    }
    clearTimeout(disarmTimer.current);
    stopArmed.current = false;
    const id = selectedId.value;
    interruptedId.current = id; // suppress Stop until the running→ready flip lands
    clearTimeout(interruptTimer.current);
    interruptTimer.current = setTimeout(() => {
      // Safety: if native never flips (or the flip is missed), stop suppressing so a
      // genuinely-running turn shows Stop again for a retry.
      if (interruptedId.current === id) {
        clearInterrupted();
        refreshSessions();
      }
    }, 5000);
    sessions.value = sessions.value.map((s) => (s.id === id ? { ...s, status: "ready" } : s));
    const restore = (reason) => {
      flashError(`✗ ${reason}`);
      clearInterrupted(); // failed → don't keep Stop suppressed
      refreshSessions(); // revert optimism to the true status
    };
    fetch(`/sessions/${encodeURIComponent(id)}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => {
        if (d && d.ok === false) restore(d.reason || "interrupt failed");
      })
      .catch(() => restore("bridge unreachable"));
  }
  function closeSlash() {
    if (!slash.current.open) return;
    slash.current.open = false;
    rerender();
  }
  async function loadSlashItems(id) {
    const cache = slashCache.current;
    if (cache.has(id)) return cache.get(id);
    try {
      const r = await fetch(`/sessions/${encodeURIComponent(id)}/skills`);
      const data = r.ok ? await r.json() : [];
      const list = Array.isArray(data) ? data : [];
      cache.set(id, list);
      return list;
    } catch {
      return []; // fetch failed → menu simply never opens; composer keeps working
    }
  }
  // Fires on every keystroke (post-mutation value). Opens the menu when the whole field is
  // a leading "/" + command token; closes it otherwise.
  async function onInput() {
    grow();
    syncHasText();
    disarmStop(); // typing cancels an armed Stop
    const el = ref.current;
    if (!el) return;
    const m = el.value.match(/^\/(\S*)$/);
    if (!m || !sid) return closeSlash();
    const items = await loadSlashItems(sid);
    const m2 = el.value.match(/^\/(\S*)$/); // re-validate: value may have changed during the await
    if (!m2) return closeSlash();
    const token = m2[1].toLowerCase();
    const filtered = items.filter((c) => c.name.toLowerCase().includes(token));
    slash.current = { open: filtered.length > 0, filtered, active: 0 };
    rerender();
  }
  function selectSlash(cmd) {
    const el = ref.current;
    if (!el || !cmd) return;
    // /model and /effort are intercepted into a native selection sheet instead of being sent
    // as text — the sheet drives the arg-form change and reports Claude's confirmation.
    if (cmd.name === "model" || cmd.name === "effort") {
      el.value = "";
      grow();
      syncHasText();
      slash.current.open = false;
      configSheet.value = { kind: cmd.name };
      rerender();
      return;
    }
    el.value = "/" + cmd.name + " "; // trailing space closes Claude's own native / menu in-pane
    grow();
    syncHasText();
    el.focus();
    slash.current.open = false;
    rerender();
  }
  async function onPick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = ""; // allow re-picking the same file
    const added = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const blob = await downscale(f);
      added.push({ blob, url: URL.createObjectURL(blob) });
    }
    if (added.length) attachments.value = [...attachments.value, ...added];
  }
  function removeAttachment(url) {
    attachments.value = attachments.value.filter((a) => a.url !== url);
    URL.revokeObjectURL(url);
  }
  async function send() {
    const el = ref.current;
    if (!el) return;
    const text = el.value;
    const items = attachments.value;
    if (!text.trim() && items.length === 0) return;
    const sid = selectedId.value;
    el.value = "";
    grow();
    syncHasText();
    el.blur(); // drop focus so the soft keyboard dismisses on submit
    if (items.length === 0) {
      pendingSends.value = [...pendingSends.value, text];
      const ok = await action(`/sessions/${encodeURIComponent(sid)}/message`, { text });
      if (!ok) {
        const idx = pendingSends.value.lastIndexOf(text);
        if (idx >= 0) pendingSends.value = pendingSends.value.filter((_, i) => i !== idx);
      }
      return;
    }
    // Image send: multipart upload + an optimistic bubble (thumbnails + caption) that the
    // transcript refresh retires once the real turn lands.
    const fd = new FormData();
    fd.append("text", text);
    items.forEach((it, i) => fd.append("image", it.blob, `image${i}.jpg`));
    const entry = { text, urls: items.map((it) => it.url) };
    pendingImageSends.value = [...pendingImageSends.value, entry];
    attachments.value = [];
    const ok = await actionForm(`/sessions/${encodeURIComponent(sid)}/message`, fd);
    if (!ok) {
      // Restore so nothing is silently lost; keep the URLs alive for the retry.
      pendingImageSends.value = pendingImageSends.value.filter((e) => e !== entry);
      attachments.value = items;
      el.value = text;
      grow();
      syncHasText();
    }
  }
  // Enter handling via NATIVE listeners (not Preact props) so the binding is unambiguous on
  // iOS. We act on `beforeinput` (inputType insertLineBreak/Paragraph) — the reliable Return
  // signal across iOS soft keyboards and hardware keyboards.
  //
  // Shift is read from the Enter keydown's e.shiftKey (requires autocapitalize="none", else
  // iOS autocapitalize spuriously sets it true on the Enter right after a newline). BUT iOS
  // only honors a HELD Shift for the FIRST Enter — it drops the modifier afterward, so a
  // held Shift+Enter ×N reports shiftKey:true once then false. We can't detect those later
  // Enters as shifted. So instead: a Shift+Enter starts a "shift run" (shiftRun) that treats
  // every following Enter as a newline (never submit) until a real keystroke ends the run.
  // Consequence: to submit right after a Shift+Enter without typing, use the Send button.
  //
  // Plain Enter (no shift run) inserts a newline and arms; a second consecutive plain Enter
  // submits (stripping that newline). Never submits an empty message.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKeyDown = (e) => {
      const s = slash.current;
      if (s.open && s.filtered.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          s.active = Math.min(s.active + 1, s.filtered.length - 1);
          return rerender();
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          s.active = Math.max(s.active - 1, 0);
          return rerender();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          return closeSlash();
        }
      }
      if (e.key === "Enter") enterShift.current = e.shiftKey; // fires before beforeinput
    };
    const onBeforeInput = (e) => {
      // Slash menu open: Enter picks the highlighted row instead of newline/submit. Reset the
      // Enter state machine so no stale arm/run leaks across the menu.
      const s = slash.current;
      if (s.open && s.filtered.length && (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph")) {
        e.preventDefault();
        enterArmed.current = false;
        shiftRun.current = false;
        selectSlash(s.filtered[s.active]);
        return;
      }
      if (e.inputType !== "insertLineBreak" && e.inputType !== "insertParagraph") {
        shiftRun.current = false; // a real keystroke (typing/delete) ends the shift run...
        enterArmed.current = false; // ...and breaks the double-Enter run
        return;
      }
      if (enterShift.current || shiftRun.current) {
        // A genuine Shift+Enter, or a held-Shift continuation iOS stripped the modifier from:
        // newline, never submit.
        shiftRun.current = true;
        enterArmed.current = false;
        return;
      }
      if (enterArmed.current && el.value.trim() !== "") {
        enterArmed.current = false;
        e.preventDefault(); // cancel the second newline
        el.value = el.value.replace(/\n$/, ""); // drop the newline the first Enter added
        send();
      } else {
        enterArmed.current = true;
      }
    };
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("beforeinput", onBeforeInput);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("beforeinput", onBeforeInput);
    };
  }, []);
  useEffect(() => {
    closeSlash();
    disarmStop();
    clearInterrupted();
  }, [sid]); // reset the menu + any armed Stop + interrupt-suppression on session switch
  useEffect(() => {
    // A turn leaving "running" means the interrupt flip landed (or the turn just ended):
    // stop suppressing Stop and disarm so it never carries a stale arm into the next turn.
    if (status !== "running") {
      disarmStop();
      clearInterrupted();
    }
  }, [status]);
  useEffect(() => () => clearTimeout(disarmTimer.current), []); // clear the disarm timer on unmount
  // One-shot autofill after a rewind: drop the rewound message back into the box (TUI parity).
  // Guarded on sessionId so a stale prefill never lands in the wrong session's composer; the
  // steady-state/mount re-fire (value null) is a no-op.
  useEffect(() => {
    const p = composerPrefill.value;
    if (!p || p.sessionId !== sid) return;
    const el = ref.current;
    if (el) {
      el.value = p.text;
      grow();
      syncHasText();
      el.focus();
    }
    composerPrefill.value = null;
  }, [composerPrefill.value]);
  return html`
    <div class="composerwrap">
      ${slash.current.open &&
      html`<div class="slash-menu">
        ${slash.current.filtered.map(
          (c, i) => html`<div
            class=${"slash-item" + (i === slash.current.active ? " active" : "")}
            key=${c.source + ":" + c.name}
            onClick=${() => selectSlash(c)}
          >
            <span class="slash-name">/${c.name}</span>
            ${c.description && html`<span class="slash-desc">${c.description}</span>`}
          </div>`,
        )}
      </div>`}
      ${attachments.value.length > 0 &&
      html`<div class="thumbs">
        ${attachments.value.map(
          (a) => html`<div class="thumb" key=${a.url}>
            <img src=${a.url} alt="" />
            <button class="thumbx" onClick=${() => removeAttachment(a.url)} aria-label="Remove">×</button>
          </div>`,
        )}
      </div>`}
      <div class="composer">
        <input ref=${fileRef} type="file" accept="image/*" multiple style="display:none" onChange=${onPick} />
        <button
          class="attach"
          disabled=${disabled}
          onClick=${() => fileRef.current && fileRef.current.click()}
          aria-label="Attach image"
        >
          ＋
        </button>
        <textarea
          ref=${ref}
          rows="1"
          placeholder="Message…"
          autocapitalize="none"
          disabled=${disabled}
          onInput=${onInput}
        ></textarea>
        ${!hasText && attachments.value.length === 0 && status === "running" && !disabled && interruptedId.current !== sid
          ? html`<button
              class=${"stop" + (stopArmed.current ? " armed" : "")}
              onClick=${onStop}
              aria-label=${stopArmed.current ? "Confirm stop" : "Stop Claude"}
            >
              ■
            </button>`
          : html`<button class="send" disabled=${disabled} onClick=${send} aria-label="Send">↑</button>`}
      </div>
    </div>
  `;
}

// Walk up from a touch target to the nearest ancestor that actually scrolls horizontally
// (content wider than its box + an overflow-x that scrolls). Used to let the back-swipe
// defer to code blocks / wide tables instead of stealing their horizontal pan.
function hScrollerAt(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return el;
    }
  }
  return null;
}

// Interactive swipe-right-to-go-back (iOS-style). Spread the returned handlers onto a
// `.screen` root: the screen tracks the finger, then on release either commits `onBack`
// (past threshold, sliding the rest of the way off first so it reads as one motion) or
// springs home. Only a clearly horizontal-right drag engages, so it never steals vertical
// scroll; it defers to an inner horizontal scroller (e.g. a code block) until that's at
// its left edge. The touchmove listener is non-passive so it can preventDefault and own
// the gesture. `deps` re-binds the listener when the root node is (re)created.
function useSwipeBack(onBack, deps = []) {
  const rootRef = useRef(null);
  const drag = useRef({ x: 0, y: 0, active: false, dx: 0, decided: false });

  function onTouchStart(e) {
    const p = e.changedTouches[0];
    drag.current = { x: p.clientX, y: p.clientY, active: false, dx: 0, decided: false, hScroller: hScrollerAt(e.target) };
    if (rootRef.current) rootRef.current.style.transition = "none";
  }
  function onTouchEnd() {
    const el = rootRef.current;
    if (!el || !drag.current.active) return;
    drag.current.active = false;
    if (drag.current.dx > Math.min(innerWidth * 0.32, 140)) {
      el.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out";
      el.style.transform = `translateX(${innerWidth}px)`;
      el.style.opacity = "0";
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        onBack();
      };
      el.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 240); // fallback if transitionend is dropped
      return;
    }
    el.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out"; // spring home
    el.style.transform = "";
    el.style.opacity = "";
  }

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    function onMove(e) {
      const p = e.changedTouches[0];
      const dx = p.clientX - drag.current.x;
      const dy = p.clientY - drag.current.y;
      if (!drag.current.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        drag.current.decided = true;
        const horizRight = dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.3; // horizontal-right only
        const sc = drag.current.hScroller;
        drag.current.active = horizRight && (!sc || sc.scrollLeft <= 0);
      }
      if (!drag.current.active) return;
      e.preventDefault();
      const tx = Math.max(0, dx);
      drag.current.dx = tx;
      el.style.transform = `translateX(${tx}px)`;
      el.style.opacity = String(1 - Math.min(tx / innerWidth, 1) * 0.35);
    }
    el.addEventListener("touchmove", onMove, { passive: false });
    return () => el.removeEventListener("touchmove", onMove);
  }, deps);

  return { rootRef, onTouchStart, onTouchEnd };
}

function Detail() {
  const t = transcript.value;
  const session = sessions.value.find((s) => s.id === selectedId.value);
  const status = session ? session.status : "";
  const turns = t ? t.turns : []; // full active branch — upCount/canCode compute over THIS
  // Optimistic rewind: show only the turns before the rewound message until the resend lands
  // (see rewindFloor). upCount/canCode still derive from the FULL branch (Claude's picker is
  // un-rewound until the resend), so a second rewind mid-window still targets correctly.
  const floor = rewindFloor.value;
  const keepTurns = floor ? floor.keepTurns : turns.length;
  const displayTurns = floor ? turns.slice(0, keepTurns) : turns;
  // Real user-turn texts in the DISPLAYED thread (image prefix stripped, matching the
  // optimistic captions). Used to suppress optimistic bubbles whose message has landed — a
  // render-time guard so a just-sent message never shows twice (the SSE only watches hook
  // events, so the pendingSends cleanup in refreshTranscript can lag the fetch). Scoped to
  // displayTurns so a rewound-then-resent message still shows as a pending bubble.
  // Messages still sitting in Claude's input queue — sent mid-turn, not yet consumed.
  // Gated on a running/waiting status: on an idle session a surviving entry is a stale
  // leftover (interrupt/popAll edge), not something about to run.
  const queued =
    t && (status === "running" || status === "waiting") ? t.queuedPending || [] : [];
  const landed = new Set();
  for (const turn of displayTurns) {
    if (turn.role !== "user") continue;
    if (turn.command) landed.add(turn.command.trim());
    for (const b of turn.content || []) {
      if (b.type === "text" && b.text) landed.add(stripImagePrefix(b.text).trim());
    }
  }
  // Queue entries count as landed too: the dim queued bubble renders them, so the
  // optimistic copy of the same text must stand down.
  for (const q of queued) landed.add(q.trim());
  const rawQuestions = t && (t.openQuestions || (t.openQuestion ? [t.openQuestion] : null));
  // "Chat about this" and a just-tapped answer/decision optimistically hide the blocking
  // card so the dock flips immediately, before the server resolves and the poll catches up.
  const optimisticHide =
    clarifying.value === selectedId.value ||
    deciding.value === selectedId.value ||
    (decidingQuestion.value && decidingQuestion.value.id === selectedId.value);
  const questions = optimisticHide ? null : rawQuestions;
  const approval = optimisticHide ? null : t && t.approval;
  // While blocked on a question/approval, the structured answer UI takes the dock —
  // otherwise it's the free-text composer (this is the "replace the message box with
  // the question/answers" behavior).
  const blocked = questions || approval;
  // An archived session has no live pane: sends/answers would fail with `no-pane`. When it's
  // not actually blocked (discovery can mislabel a live blocked session as archived — those
  // stay answerable), lock the composer and show a standing notice instead of a dead end.
  const archived = status === "archived" && !blocked;

  // Swipe-right-to-go-back translates the whole Detail screen (rootRef) back to the list.
  const { rootRef, onTouchStart, onTouchEnd } = useSwipeBack(back);
  const scrollRef = useRef(null); // the thread is the ONLY scroll region (app-shell layout)
  const follow = useRef(true); // auto-scroll only while the user is near the bottom
  const [showJump, setShowJump] = useState(false); // floating "jump to latest" button
  const lastId = useRef(null);

  // Attention-jump button: count of OTHER blocked sessions (the queue minus this one).
  const otherAttention = attentionSessions().filter((s) => s.id !== selectedId.value).length;

  // Background work — agents the session fanned out to plus background scripts it is
  // waiting on (run_in_background Bash, no completion notification yet). Both are the
  // same harness machinery (tasks + task-notification) and share one surface: the
  // navbar pill (glance) → the AgentList sheet (labels). A script wait is the case
  // where status honestly reads "ready" while work is in flight — the mint pill is
  // the in-detail tell, same affordance as running agents.
  const agents = (t && t.subagents) || [];
  const runningAgents = agents.filter((a) => a.status === "running").length;
  const scripts = (t && t.pendingScripts) || [];
  const activeWork = runningAgents + scripts.length;

  // 15s safety poll while any background work is live — covers agent hard-kills (which
  // fire no SubagentStop hook) and a script wake that produces no immediate hook edge.
  // SSE stays the instant primary path; this stops the moment everything is done.
  useEffect(() => {
    if (activeWork === 0) return;
    const iv = setInterval(() => {
      refreshTranscript();
      if (openSubagent.value) refreshSubagent();
    }, 15000);
    return () => clearInterval(iv);
  }, [activeWork]);

  // 2.5s poll while a send is in flight (optimistic bubble up) or a message sits in
  // Claude's queue. Both states advance WITHOUT any hook event — a mid-turn send fires
  // no UserPromptSubmit when enqueued, and its consumption (queue remove + attachment)
  // is a bare transcript append — so the SSE never wakes and the thread would sit on
  // the optimistic/queued bubble until the next unrelated event or a remount. Stops
  // the moment nothing is pending or queued.
  const sendsInFlight = pendingSends.value.length + pendingImageSends.value.length;
  const queuedCount = (t && t.queuedPending && t.queuedPending.length) || 0;
  useEffect(() => {
    if (sendsInFlight === 0 && queuedCount === 0) return;
    const iv = setInterval(refreshTranscript, 2500);
    return () => clearInterval(iv);
  }, [sendsInFlight > 0, queuedCount > 0]);

  // Track whether we're pinned to the bottom of the thread. The 80px slack keeps auto-follow
  // alive through small jitters; the floating controls (down button + prompt-nav pill) appear
  // the moment we're off the bottom by that same slack — so "not at bottom" ⇒ buttons shown.
  function syncFloat() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    follow.current = atBottom;
    setShowJump(!atBottom);
  }

  // Tap the floating button: smooth-scroll to the newest message. Don't pre-arm follow or
  // force a state change here — the post-render effect snaps `scrollTop = scrollHeight`
  // instantly whenever follow is true, which races this smooth scroll and causes the
  // flicker. syncFloat re-arms follow and fades the button out on its own as we land.
  function jumpToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // Prev/next-prompt navigation: scroll to the user message just above (dir -1) or below
  // (dir +1) the current viewport top. Offsets are measured live from the DOM so they stay
  // correct as bubbles grow/shrink. At the ends it clamps — first prompt / thread bottom.
  function jumpPrompt(dir) {
    const el = scrollRef.current;
    if (!el) return;
    const cTop = el.getBoundingClientRect().top;
    const tops = [...el.querySelectorAll(".bubble.user:not(.pending)")].map(
      (b) => el.scrollTop + b.getBoundingClientRect().top - cTop,
    );
    if (!tops.length) return;
    // A jumped prompt lands `pad + GAP` below the container top (pad carries the status-bar
    // safe-area inset in standalone PWA mode, so it never butts against the top edge). The
    // prompt currently in focus therefore sits at offset `scrollTop + pad + GAP` — compare
    // next/prev against THAT line, not raw scrollTop, or the focused prompt reads as "below
    // us" and the next-search keeps re-selecting it (the stuck-button bug).
    const GAP = 12;
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const ref = el.scrollTop + pad + GAP;
    let target;
    if (dir < 0) {
      const prev = tops.filter((y) => y < ref - 4);
      target = prev.length ? prev[prev.length - 1] : tops[0];
    } else {
      const next = tops.find((y) => y > ref + 4);
      target = next != null ? next : el.scrollHeight;
    }
    el.scrollTo({ top: Math.max(0, target - pad - GAP), behavior: "smooth" });
  }

  // After each render: re-pin to the newest output (forced on session switch) unless the
  // user has scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (lastId.current !== selectedId.value) {
      lastId.current = selectedId.value;
      follow.current = true;
    }
    if (follow.current) el.scrollTop = el.scrollHeight;
    // Recompute button visibility after the DOM settles (new content can push us off the
    // bottom without firing a scroll event), so the controls don't lag behind streaming.
    syncFloat();
  });

  const usage = t && t.usage;
  const mode = t && t.mode; // permission mode (auto/plan), scraped from the pane
  // Statusline (scraped from the pane) is `tokens • branch • model • thinking`; keep
  // just tokens + branch so it stays on one line. Auto mode is yellow (matches the TUI).
  const statusline = t && t.statusline ? t.statusline.split(" • ").slice(0, 2).filter(Boolean).join(" • ") : "";
  const modeColor = mode && /auto/i.test(mode) ? "var(--yellow)" : "var(--mint)";
  return html`
    <div
      class="screen detail"
      ref=${rootRef}
      onTouchStart=${onTouchStart}
      onTouchEnd=${onTouchEnd}
    >
      <div class="scroll thread" ref=${scrollRef} onScroll=${syncFloat}>
        ${!t && html`<div class="sub" style="padding:8px">loading…</div>`}
        ${(() => {
          // Per user turn: upCount = Up-presses to reach it in the /rewind picker (0 = not a
          // checkpoint, so no rewind offered); canCode = whether any file-editing tool ran
          // after it (offer code-restore only when there's code to restore — Bash edits aren't
          // checkpointed, matching Claude). Both derive from the FULL branch (Claude's picker
          // is un-rewound until the resend), so a second rewind mid-window still targets right.
          const n = turns.length;
          const editAfter = new Array(n).fill(false);
          let sawEdit = false;
          for (let i = n - 1; i >= 0; i--) {
            editAfter[i] = sawEdit;
            if ((turns[i].content || []).some((b) => b.type === "tool_use" && EDIT_TOOLS.has(b.name))) {
              sawEdit = true;
            }
          }
          const upByIndex = upCountByIndex(turns);
          return turns.map((turn, i) => {
            const up = upByIndex.get(i) || 0;
            if (i >= keepTurns) return null; // truncated by an optimistic rewind
            return html`<${Turn} key=${i} turn=${turn} upCount=${up} canCode=${editAfter[i]} />`;
          });
        })()}
        ${queued.map(
          (text, i) => html`<div class="bubble user queued" key=${`q${i}`}>
            ${text}
            <div class="queuedtag">queued</div>
          </div>`,
        )}
        ${pendingSends.value
          .filter((text) => !landed.has(text.trim()))
          .map((text, i) => html`<div class="bubble user pending" key=${`p${i}`}>${text}</div>`)}
        ${pendingImageSends.value
          .filter((e) => !landed.has(stripImagePrefix(e.text).trim()))
          .map(
            (e, i) => html`<div class="bubble user pending imgbubble" key=${`pi${i}`}>
            <div class="bubthumbs">${e.urls.map((u) => html`<img src=${u} alt="" key=${u} />`)}</div>
            ${e.text && html`<div>${e.text}</div>`}
          </div>`,
          )}
        ${t && t.pendingTool && !blocked && html`<${RunningTool} tool=${t.pendingTool} />`}
        ${status === "running" && !blocked && html`<div class="typing">working…</div>`}
        ${!archived && html`<${ChangesCard} />`}
      </div>
      <div class="dock">
        <div class="dockbtns">
          ${displayTurns.filter(isPromptTurn).length >= 2 &&
          html`<div class=${`promptnav${showJump ? " show" : ""}`}>
            <button onClick=${() => jumpPrompt(-1)} aria-label="Previous prompt">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 15l6-6 6 6" />
              </svg>
            </button>
            <button onClick=${() => jumpPrompt(1)} aria-label="Next prompt">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>`}
          <button
            class=${`scrollbtn${showJump ? " show" : ""}`}
            onClick=${jumpToBottom}
            aria-label="Scroll to latest"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
        <div class="dock-inner">
          ${archived
            ? session && session.restorable
              ? html`<div class="flash archived restore-row">
                  <button
                    class="primary restore-btn"
                    disabled=${restoring.value}
                    onClick=${restoreSession}
                  >
                    ${restoring.value ? "Restoring…" : "Restore session"}
                  </button>
                  ${flash.value && html`<span class="restore-err">${flash.value}</span>`}
                </div>`
              : html`<div class="flash archived">Archived — resume from your Mac to continue this session.</div>`
            : flash.value && html`<div class="flash">${flash.value}</div>`}
          <div class="navbar">
            <button class="iconbtn" onClick=${back} aria-label="Back to sessions">‹</button>
            <div class="navtitle">${session ? session.label || session.repo : "session"}</div>
            ${(agents.length > 0 || scripts.length > 0) &&
            html`<button
              class="agentspill${activeWork > 0 ? "" : " archive"}"
              onClick=${() => (showAgents.value = true)}
              aria-label="Background work"
            >
              ${activeWork > 0
                ? html`${runningAgents > 0 && html`🤖 <span class="run">${runningAgents}</span>`}${runningAgents >
                      0 && scripts.length > 0
                      ? " "
                      : ""}${scripts.length > 0 && html`⏳ <span class="run">${scripts.length}</span>`}`
                : html`🤖 ${agents.length}`}
            </button>`}
            <span class="meta">
              ${status && html`<span style=${`color:${DOT_COLOR[status] ?? "var(--dim)"}`}>${DOT[status]}</span>`}
              ${!statusline &&
              usage &&
              html`<span class="usage" style=${`color:${usageColor(usage.percent)}`}>${usage.percent}%</span>`}
            </span>
            ${otherAttention > 0 &&
            html`<button class="attn" onClick=${gotoNextAttention} aria-label="Next session needing attention">
              ⚡ ${otherAttention} ›
            </button>`}
          </div>
          ${(statusline || mode) &&
          html`<div class="statusbar">
            ${mode && html`<span class="modebadge" style=${`color:${modeColor}`}>${mode}</span>`}
            ${statusline && html`<span class="sltext">${statusline}</span>`}
          </div>`}
          ${questions
            ? html`<${QuestionCard} questions=${questions} toolUseId=${t.pendingTool && t.pendingTool.toolUseId} />`
            : approval
              ? html`<${ApprovalCard} approval=${approval} />`
              : html`<${Composer} disabled=${archived} status=${status} />`}
        </div>
      </div>
    </div>
  `;
}

// Long-press action sheet for a user message: copy, or rewind to before it via Claude's
// /rewind picker (driven + verified server-side). Rewind is hidden while the session is
// busy (the picker only opens at the prompt).
function ActionSheet() {
  const m = menuText.value;
  if (m == null) return null;
  const close = () => (menuText.value = null);
  const session = sessions.value.find((s) => s.id === selectedId.value);
  const busy = session && (session.status === "running" || session.status === "waiting");
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheetpreview">${m.text}</div>
          <button onClick=${() => copyMessage(m.text)}>Copy</button>
          ${!m.assistant &&
          !busy &&
          m.upCount > 0 &&
          html`<button class="danger" onClick=${() => rewind("conversation")}>Rewind conversation to here</button>`}
          ${!m.assistant &&
          !busy &&
          m.upCount > 0 &&
          m.canCode &&
          html`<button class="danger" onClick=${() => rewind("both")}>Rewind code + conversation</button>`}
          ${!m.assistant && busy && html`<div class="sheethint">Rewind is available at the prompt.</div>`}
          <button class="sheetcancel" onClick=${close}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

// Long-press action sheet for a session ROW (home list). A header identifies the session
// being acted on (status dot + name + repo · subline + age), then the actions. Archive is
// destructive (kills the live Claude process), so it takes a second tap that swaps the
// sheet to an explicit confirm — no accidental kills from a fat-fingered long-press.
function SessionSheet() {
  const s = sessionMenu.value;
  const [confirm, setConfirm] = useState(false);
  // The sheet returns null when closed instead of unmounting, so `confirm` would
  // otherwise persist — reset it each time the target changes (open/close/switch).
  useEffect(() => setConfirm(false), [s]);
  if (s == null) return null;
  const close = () => (sessionMenu.value = null);
  const sub = subLine(s);
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheethead">
            <span class="dot" style=${dotStyle(s)}></span>
            <span class="grow">
              <span class="name">${listTitle(s)}</span>
              <span class="sub">${sub ? `${s.repo} · ${sub}` : s.repo}</span>
            </span>
            <span class="age">${formatAge(activityAt(s))}</span>
          </div>
          ${confirm
            ? html`
                <div class="sheethint">
                  This ends the live Claude session. Your conversation is saved — resume it from your Mac anytime.
                </div>
                <button class="danger-fill" onClick=${archiveSession}>Archive session</button>
                <button class="sheetcancel" onClick=${() => setConfirm(false)}>Keep running</button>`
            : html`
                <button onClick=${() => (close(), open(s.id))}>Open</button>
                <button class="danger" onClick=${() => setConfirm(true)}>Archive session</button>
                <button class="sheetcancel" onClick=${close}>Cancel</button>`}
        </div>
      </div>
    </div>
  `;
}

// Background-work sheet — everything the session runs beside the main conversation, in one
// list. Pending background scripts first (they explain a session that reads "ready" while
// mid-work, and have no other surface — script rows aren't tappable, there's no conversation
// behind a shell loop), then running agents, then agents that finished SINCE YOUR LAST
// PROMPT (fresh reports — likely why the sheet was opened), then everything older collapsed
// behind one "earlier" row: fan-out-heavy sessions pile up dozens of stale rows, but
// finished reports must stay reachable — the drill-in is the only place a phone user can
// read them (tool_results are stripped from the thread).
function AgentList() {
  const [showOlder, setShowOlder] = useState(false);
  if (!showAgents.value) return null;
  const t = transcript.value;
  const list = (t && t.subagents) || [];
  const scripts = (t && t.pendingScripts) || [];
  const close = () => ((showAgents.value = false), setShowOlder(false));
  // Boundary unknown (no prompt yet / no finishedAt) → err toward fresh: hiding a report
  // is worse than one extra row.
  const lastPrompt = t && t.lastPromptAt ? new Date(t.lastPromptAt).getTime() : null;
  const isFresh = (a) =>
    !lastPrompt || !a.finishedAt || new Date(a.finishedAt).getTime() >= lastPrompt;
  const running = list.filter((a) => a.status === "running");
  const fresh = list.filter((a) => a.status !== "running" && isFresh(a));
  const older = list.filter((a) => a.status !== "running" && !isFresh(a));
  // Drill-in prev/next walks the DISPLAY order, older included, so nothing is unreachable.
  const ordered = [...running, ...fresh, ...older];
  const row = (a) => html`
    <button
      type="button"
      class="agent-row"
      key=${a.agentId}
      onClick=${() => openAgent(a, ordered)}
      style=${a.spawnDepth > 1 ? `padding-left:${12 + Math.min(a.spawnDepth - 1, 4) * 14}px` : ""}
    >
      <span class="dot" style=${`background:${a.status === "running" ? "var(--mint)" : "var(--peach)"}`}></span>
      <span class="grow">
        <span class="name">${a.description || a.agentType}</span>
        <span class="sub">
          ${a.agentType}${a.status === "running"
            ? " · running"
            : a.finishedAt
              ? ` · ${formatTimeAgo(a.finishedAt)}`
              : ""}
        </span>
      </span>
      <span class="chev">›</span>
    </button>
  `;
  // Script row — same anatomy as agent rows (dot / name / sub) so the sheet reads as one
  // list, but a div (not a button): no drill-in target exists.
  const scriptRow = (sc) => html`
    <div class="agent-row script" key=${sc.toolUseId}>
      <span class="dot" style="background:var(--mint)"></span>
      <span class="grow">
        <span class="name">${sc.label}</span>
        <span class="sub">script · ${formatTimeAgo(sc.launchedAt) || "running"}</span>
      </span>
      <span class="scripthint">⏳</span>
    </div>
  `;
  // Header = state summary, not a bare noun: "1 waiting · 2 running · 5 done".
  const doneCount = fresh.length + older.length;
  const headParts = [
    scripts.length > 0 && `${scripts.length} waiting on script${scripts.length === 1 ? "" : "s"}`,
    running.length > 0 && `${running.length} running`,
    doneCount > 0 && `${doneCount} done`,
  ].filter(Boolean);
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheethead">
            <span class="grow"><span class="name">${headParts.join(" · ") || "background work"}</span></span>
          </div>
          <div class="agents-sheet">
            ${scripts.map(scriptRow)} ${running.map(row)} ${fresh.map(row)}
            ${older.length > 0 &&
            html`<button type="button" class="agent-row older-toggle" onClick=${() => setShowOlder(!showOlder)}>
              <span class="grow"><span class="sub">${showOlder ? "▾" : "▸"} ${older.length} earlier agent${older.length === 1 ? "" : "s"}</span></span>
            </button>`}
            ${showOlder && older.map(row)}
          </div>
          <button class="sheetcancel" onClick=${close}>Close</button>
        </div>
      </div>
    </div>
  `;
}

// Subagent drill-in — a full-screen push over the detail rendering the agent's conversation
// through the existing Turn. The opening user turn (the task brief) is collapsed under a
// ▸ Brief toggle; the footer steps across sibling agents; the back chevron returns to the
// session. Refreshed by the same SSE wake + 15s poll as the list.
function SubagentView() {
  const o = openSubagent.value;
  const [showBrief, setShowBrief] = useState(false);
  // Swipe-right-to-go-back closes the drill-in. Re-binds when a drill-in opens (dep on
  // agentId): the root node only exists while `o` is set.
  const { rootRef, onTouchStart, onTouchEnd } = useSwipeBack(closeSubagent, [o ? o.agentId : null]);

  if (!o) return null;
  const data = subTranscript.value;
  const turns = (data && data.turns) || [];
  // Opening user turn = the task brief; the rest is the agent's actual work.
  const opening = turns[0] && turns[0].role === "user" ? turns[0] : null;
  const body = opening ? turns.slice(1) : turns;
  const sibs = o.siblings || [];
  const idx = sibs.findIndex((s) => s.agentId === o.agentId);
  const prev = idx > 0 ? sibs[idx - 1] : null;
  const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null;
  return html`
    <div class="screen subagent-view" ref=${rootRef} onTouchStart=${onTouchStart} onTouchEnd=${onTouchEnd}>
      <div class="subagent-head">
        <button class="iconbtn" onClick=${closeSubagent} aria-label="Back to session">‹</button>
        <span class="grow">
          <span class="name">${o.description || o.agentType}</span>
          <span class="sub">${o.agentType}</span>
        </span>
      </div>
      <div class="scroll">
        ${!data && html`<div class="sub" style="padding:8px">loading…</div>`}
        ${opening &&
        html`<div class="brief">
          <button class="brief-toggle" onClick=${() => setShowBrief(!showBrief)}>
            ${showBrief ? "▾" : "▸"} Brief
          </button>
          ${showBrief && html`<${Turn} turn=${opening} upCount=${0} canCode=${false} />`}
        </div>`}
        ${body.map((turn, i) => html`<${Turn} key=${i} turn=${turn} upCount=${0} canCode=${false} />`)}
        ${data && turns.length === 0 && html`<div class="sub" style="padding:8px">no conversation</div>`}
      </div>
      ${(prev || next) &&
      html`<div class="subagent-foot">
        ${prev
          ? html`<button class="sibnav" onClick=${() => openAgent(prev, sibs)}>‹ ${prev.description || prev.agentType}</button>`
          : html`<span class="sibnav-spacer"></span>`}
        ${next
          ? html`<button class="sibnav" onClick=${() => openAgent(next, sibs)}>${next.description || next.agentType} ›</button>`
          : html`<span class="sibnav-spacer"></span>`}
      </div>`}
    </div>
  `;
}

// Git status letter → color class (A added, M modified, D deleted; else muted).
const STATUS_CLASS = { A: "st-a", M: "st-m", D: "st-d", R: "st-r" };

// "branch vs base" — the baseline every changed-files surface is measured against. The list
// is everything this BRANCH changed vs its base (committed and uncommitted, your own earlier
// edits and any parallel session's included), not an attribution of what this session did.
// Saying so is what stops "+248 −301" reading as "the agent wrote all that".
const baseline = (d) =>
  d && d.branch ? `${d.branch}${d.base && d.base !== d.branch ? ` vs ${d.base}` : ""}` : "";

// One file's status badge + path (dir dimmed, filename bright) + LOC delta — shared by the
// changed-files card preview and the full list so both read identically.
function fileLine(f) {
  const slash = f.path.lastIndexOf("/");
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
  return html`
    <span class=${"fl-badge " + (STATUS_CLASS[f.status] || "st-o")}>${f.status || "M"}</span>
    <span class="fl-path"><span class="fl-dir">${dir}</span><span class="fl-base">${base}</span></span>
    <span class="fl-stat">
      ${f.binary
        ? html`<span class="cbin">bin</span>`
        : html`<span class="cadd">+${f.add}</span> <span class="cdel">−${f.del}</span>`}
    </span>`;
}

// A 5-cell diffstat bar (GitHub-style): cells filled green for the additions proportion, red
// for deletions, dim for the remainder. Guarantees ≥1 colored cell when a side is non-zero.
function diffBar(add, del) {
  const total = add + del;
  let g = total ? Math.round((add / total) * 5) : 0;
  let r = total ? 5 - g : 0;
  if (add > 0 && g === 0) (g = 1), (r = 4);
  if (del > 0 && r === 0) (r = 1), (g = Math.min(g, 4));
  const cells = [];
  for (let i = 0; i < 5; i++) cells.push(html`<span class=${"db " + (i < g ? "db-a" : i < g + r ? "db-d" : "db-o")}></span>`);
  return html`<span class="diffbar">${cells}</span>`;
}

// The changed-files strip at the END of the scrollable thread (not the fixed dock, so it costs
// no composer viewport). Totals and the PR state only — no file preview: the list is ordered
// latest-modified, so the first three of a 144-file branch are an arbitrary sample that reads
// as a summary (three test files imply "tests only"). Tapping ANYWHERE opens the full list.
// Hidden entirely when the session changed nothing. Refetches on each new transcript revision,
// and again whenever the bridge comes back after a drop.
function ChangesCard() {
  const sid = selectedId.value;
  const rev = transcript.value && transcript.value.rev;
  const online = connected.value;
  // Paint the last-known list for this session immediately (stale-while-revalidate);
  // the fetch below replaces it.
  const [data, setData] = useState(() => (sid && changesDataCache.get(sid)) || null);
  // A session switch must not leave the previous session's files on screen — reset to
  // the NEW session's cached list (or nothing). Declared before the fetch effect so it
  // runs first when `sid` changes.
  useEffect(() => setData((sid && changesDataCache.get(sid)) || null), [sid]);
  useEffect(() => {
    if (!sid) return;
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/changes`);
        if (!r.ok) return;
        const d = await r.json();
        boundedSet(changesDataCache, sid, d);
        if (!stale) setData(d);
      } catch {
        // Unreachable bridge (the normal state on a train). Keep the last known list rather
        // than replacing it with an empty one — an empty list HIDES the card, which reads as
        // "the agent changed nothing". The global offline banner already says why it's stale.
      }
    })();
    return () => (stale = true);
  }, [sid, rev, online]);
  const pr = usePullRequest(sid);
  const files = (data && data.files) || [];
  if (files.length === 0) return null;
  const totAdd = files.reduce((s, f) => s + f.add, 0);
  const totDel = files.reduce((s, f) => s + f.del, 0);
  // The PR chip is display-only here — the strip has ONE action (open the list), and the link
  // out to GitHub lives on the list itself. A merged PR showing at glance level is the point:
  // it says this session's work already landed.
  const prState = pr && PR_TONE[pr.state] ? pr : null;
  // A <div role=button>, NOT a <button>: WebKit (iOS Safari) refuses to render block/flex
  // children inside a <button>, collapsing it to an empty padded box. A div renders its block
  // children everywhere and still takes the click.
  return html`
    <div class="changes-card" role="button" tabindex="0" onClick=${() => (filesView.value = true)}>
      <div class="cc-main">
        <span class="cc-count">${files.length} file${files.length === 1 ? "" : "s"}</span>
        <span class="cadd">+${totAdd}</span>
        <span class="cdel">−${totDel}</span>
        ${diffBar(totAdd, totDel)}
        <span class="cc-chev">→</span>
      </div>
      <div class="cc-meta">
        ${prState &&
        html`<span class=${"pr-chip " + PR_TONE[prState.state]}>${prState.state} #${prState.number}</span>${prLoc(
          prState,
        )}`}
        ${baseline(data) && html`<span class="cc-base">${baseline(data)}</span>`}
      </div>
    </div>
  `;
}

// Full-screen diff for one file — the branch-vs-base patch (committed + uncommitted), parsed
// by the shared /diff-lines.js and colored here. The header states the baseline it was
// measured against. A big diff collapses to the first 380 lines behind a "Load full diff" tap.
const DIFF_COLLAPSE = 380;
// Strips `@@ -1,4 +1,6 @@` off a hunk header, keeping only git's trailing context (the
// enclosing function). Line numbers are noise on a phone; the function name is the one bit of
// "where am I" worth the row.
const HUNK_RANGE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?/;
// A wholly-new or wholly-deleted file has no context lines and only one kind of change, so the
// gutter marks, row tints and hunk header are constants — three channels spent restating the
// `A`/`D` badge already in the header, at the cost of contrast and 14px of width. Such a file
// renders as a plain listing instead.
const isUniform = (lines) => {
  const kinds = new Set(lines.map((l) => l.t));
  return !kinds.has("ctx") && !(kinds.has("add") && kinds.has("del"));
};
function DiffView() {
  const v = diffView.value;
  const [data, setData] = useState(null);
  const [wrap, setWrap] = useState(false);
  const [full, setFull] = useState(false);
  const { rootRef, onTouchStart, onTouchEnd } = useSwipeBack(() => (diffView.value = null), [v ? v.path : null]);
  const sid = selectedId.value;
  const path = v ? v.path : null;
  const orig = v ? v.orig : null; // old path of a rename → the route diffs both endpoints
  useEffect(() => {
    if (!path) return;
    setData(null);
    setFull(false);
    let stale = false;
    (async () => {
      try {
        const q = `path=${encodeURIComponent(path)}${orig ? `&orig=${encodeURIComponent(orig)}` : ""}`;
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/diff?${q}`);
        // A failed REQUEST is not a git answer: keep the two apart so an unreachable bridge
        // never renders as "this file has no changes".
        const d = r.ok ? await r.json() : { error: true };
        if (!stale) setData(d);
      } catch {
        if (!stale) setData({ offline: true });
      }
    })();
    return () => (stale = true);
  }, [path, orig, sid]);
  if (!v) return null;
  const bad = data && (data.error || data.offline);
  // Re-indent to 2 spaces per level: a 4-space file at depth 5 spends 20 of ~45 phone columns
  // before the first character. Leading whitespace only, levels preserved — see narrowIndent.
  const parsed = data && !bad && data.patch ? narrowIndent(parseDiffLines(data.patch)) : [];
  // A non-empty patch that strips to zero display lines is a metadata-only change (file
  // mode, pure rename) — render a notice, not a blank body.
  const metaOnly = data && !bad && data.patch && parsed.length === 0;
  const ok = parsed.length > 0;
  const lines = parsed;
  const plain = ok && isUniform(lines);
  // A plain listing has no hunk headers to show — a new file's single `@@` row would be a
  // lone piece of diff chrome above otherwise ordinary code.
  const body = plain ? lines.filter((l) => l.t !== "hunk") : lines;
  const shown = full ? body : body.slice(0, DIFF_COLLAPSE);
  const sub = data && !bad
    ? `${baseline(data) || "—"} · +${data.add} −${data.del}`
    : path;
  // The basename alone is ambiguous in any repo with repeated leaf names (`app/[slug]/page.tsx`
  // vs `app/s/page.tsx`), so the header carries the directory too — dimmed and truncating, the
  // same treatment the file list uses.
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return html`
    <div class="screen files-view diff-view" ref=${rootRef} onTouchStart=${onTouchStart} onTouchEnd=${onTouchEnd}>
      <div class="subagent-head">
        <button class="iconbtn" onClick=${() => (diffView.value = null)} aria-label="Back to session">‹</button>
        <span class="grow"
          ><span class="fl-path dv-name"
            >${data && data.status
              ? html`<span class=${"fl-badge " + (STATUS_CLASS[data.status] || "st-o")}>${data.status}</span>`
              : ""}<span class="fl-dir">${dir}</span><span class="fl-base">${base}</span></span
          ><span class="sub">${sub}</span
          >${data && data.orig && html`<span class="sub dv-rename">renamed from ${data.orig}</span>`}</span
        >
        ${ok &&
        html`<button
          class=${"hdrtoggle" + (wrap ? " on" : "")}
          aria-pressed=${wrap ? "true" : "false"}
          onClick=${() => setWrap(!wrap)}
        >
          wrap
        </button>`}
      </div>
      <div class="scroll" style="padding:0">
        ${!data && html`<div class="sub" style="padding:12px">loading…</div>`}
        ${data && data.offline && html`<div class="guard">Couldn't reach the bridge — diff not loaded.</div>`}
        ${data && data.error && html`<div class="guard">Couldn't load this file — it may have moved.</div>`}
        ${data && data.empty && html`<div class="guard">No changes vs ${data.base || "the base branch"}.</div>`}
        ${metaOnly && html`<div class="guard">Metadata-only change (file mode or rename) — no content diff.</div>`}
        ${data && data.binary && html`<div class="guard">Binary file — not shown.</div>`}
        ${data && data.tooLarge && html`<div class="guard">Diff too large to preview.</div>`}
        ${ok &&
        html`<div class=${"diffbody" + (wrap ? " wrap" : "") + (plain ? " plain" : "")}>
          ${shown.map((l, i) =>
            plain
              ? html`<div class="dl plain" key=${i}><span class="c">${l.s}</span></div>`
              : l.t === "hunk"
                ? html`<div class="dl hunk" key=${i}><span class="c">${l.s.replace(HUNK_RANGE, "")}</span></div>`
                : html`<div class=${"dl " + l.t} key=${i}>
                    <span class="g">${l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>
                    <span class="c">${l.s}</span>
                  </div>`,
          )}
          ${!full &&
          body.length > DIFF_COLLAPSE &&
          html`<button class="loadfull" onClick=${() => setFull(true)}>Load full diff (${body.length} lines)</button>`}
        </div>`}
      </div>
    </div>
  `;
}

// The session branch's GitHub PR, at the top of the changed-files list — the exit from this
// glance surface to the real review surface (docs/adr/0001). Renders nothing when there's
// nothing to link (default branch, no GitHub remote, no gh), so it never becomes a dead row on
// the repos worked directly on main.
const PR_TONE = { open: "pr-open", draft: "pr-draft", merged: "pr-merged", closed: "pr-closed" };
// The PR's own LOC delta (GitHub's merge-base diff). Distinct from the changed-files totals,
// which include uncommitted and untracked work the PR hasn't seen.
const prLoc = (d) =>
  html`<span class="pr-loc"><span class="cadd">+${d.add}</span> <span class="cdel">−${d.del}</span></span>`;
function usePullRequest(sid) {
  // Same stale-while-revalidate as ChangesCard: last-known PR paints instantly, the
  // fetch replaces it (the /pr route itself revalidates behind its 60s freshness).
  const [d, setD] = useState(() => (sid && prDataCache.get(sid)) || null);
  useEffect(() => {
    setD((sid && prDataCache.get(sid)) || null);
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/pr`);
        if (!r.ok) return;
        const fresh = await r.json();
        boundedSet(prDataCache, sid, fresh);
        if (!stale) setD(fresh);
      } catch {
        // Unreachable bridge — the surrounding surfaces already report it; stay silent here.
      }
    })();
    return () => (stale = true);
  }, [sid]);
  return d && d.state !== "none" ? d : null;
}

function PrRow({ sid }) {
  const d = usePullRequest(sid);
  if (!d) return null;
  // Not pushed: no link to give, but say so — otherwise the absence reads as "no PR exists"
  // when the truth is "this work has never left your Mac".
  if (d.state === "local-only")
    return html`<div class="pr-row pr-inert">
      <span class="pr-chip pr-closed">local</span>
      <span class="pr-text">${d.branch} isn't pushed yet</span>
    </div>`;
  if (d.state === "no-pr")
    return html`<a class="pr-row" href=${d.compareUrl} target="_blank" rel="noreferrer">
      <span class="pr-chip pr-draft">no pr</span>
      <span class="pr-text">Open a pull request for ${d.branch}</span>
      <span class="pr-out">↗</span>
    </a>`;
  // One line: the title truncates, everything else is fixed-width. `reviewDecision` is
  // deliberately not shown — it would either wrap the row or eat the title.
  return html`<a class="pr-row" href=${d.url} target="_blank" rel="noreferrer">
    <span class=${"pr-chip " + PR_TONE[d.state]}>${d.state} #${d.number}</span>
    <span class="pr-text">${d.title}</span>
    ${prLoc(d)}
    <span class="pr-out">↗</span>
  </a>`;
}

// Full changed-files list pushed over the detail (the card's "view all" target). Same
// session-scoped /changes source, latest-modified first; tapping a row opens that file's diff.
function FilesView() {
  const open = filesView.value;
  const rev = transcript.value && transcript.value.rev;
  const [data, setData] = useState(null);
  const online = connected.value;
  const { rootRef, onTouchStart, onTouchEnd } = useSwipeBack(() => (filesView.value = false), [open]);
  const sid = selectedId.value;
  // Never carry one session's file list into another — reset to the new session's
  // cached list (shared with ChangesCard). Declared before the fetch effect so it
  // runs first when `sid` changes.
  useEffect(() => setData((sid && changesDataCache.get(sid)) || null), [sid]);
  useEffect(() => {
    if (!open) return;
    let stale = false;
    (async () => {
      try {
        const r = await fetch(`/sessions/${encodeURIComponent(sid)}/changes`);
        const d = r.ok ? await r.json() : { error: true };
        if (r.ok) boundedSet(changesDataCache, sid, d);
        if (!stale) setData(d);
      } catch {
        // Unreachable bridge: hold the last known list (see ChangesCard) and say so only
        // when there's nothing to hold.
        if (!stale) setData((prev) => (prev && prev.files ? prev : { offline: true }));
      }
    })();
    return () => (stale = true);
  }, [open, sid, rev, online]);
  if (!open) return null;
  const bad = data && (data.error || data.offline);
  const files = (data && data.files) || [];
  return html`
    <div class="screen files-view" ref=${rootRef} onTouchStart=${onTouchStart} onTouchEnd=${onTouchEnd}>
      <div class="subagent-head">
        <button class="iconbtn" onClick=${() => (filesView.value = false)} aria-label="Back to session">‹</button>
        <span class="grow"
          ><span class="name">Changed files</span>${data &&
          !bad &&
          html`<span class="sub">${files.length}${baseline(data) ? ` · ${baseline(data)}` : ""}</span>`}</span
        >
      </div>
      <div class="scroll">
        <${PrRow} sid=${sid} />
        ${!data && html`<div class="sub" style="padding:8px">loading…</div>`}
        ${data && data.offline && html`<div class="guard">Couldn't reach the bridge — list not loaded.</div>`}
        ${data && data.error && html`<div class="guard">No live repo for this session.</div>`}
        ${data && !bad && files.length === 0 && html`<div class="guard">No file changes yet.</div>`}
        ${files.map(
          (f) => html`<div
            class="changerow"
            role="button"
            tabindex="0"
            key=${f.path}
            onClick=${() => (diffView.value = { path: f.path, orig: f.orig })}
          >
            ${fileLine(f)}
          </div>`,
        )}
      </div>
    </div>
  `;
}

function App() {
  if (loadingAuth.value) return html`<${Spinner} />`;
  if (!authed.value) return html`<${Login} />`;
  const screen = showNewSession.value
    ? html`<${NewSession} />`
    : selectedId.value
      ? html`<${Detail} />`
      : html`<${List} />`;
  // Bottom connectivity banner: a failed fetch ("bridge unreachable") is the persistent
  // state (stays until a refresh succeeds); a dropped SSE socket is the transient one.
  const banner = error.value === "bridge unreachable" ? "bridge unreachable" : !connected.value ? "reconnecting…" : null;
  return html`${screen}${banner && html`<div class="offline">${banner}</div>`}<${ActionSheet} /><${SessionSheet} /><${ConfigSheet} /><${AgentList} /><${SubagentView} /><${DiffView} /><${FilesView} /><${NoticeToast} /><${CopiedToast} />`;
}

// A brief centered "✓ copied" pill, shown on any successful clipboard write.
// Selection sheets for /model and /effort. Options mirror Claude's own pickers. The current
// value is read from the pane-scraped statusline (transcript.model / .effort, arg keys); note
// "Default" reads as `opus` on the statusline, so Opus is marked when Default is active.
const MODEL_OPTS = [
  { key: "default", label: "Default", sub: "recommended · Opus 4.8 1M" },
  { key: "opus[1m]", label: "Opus", sub: "Opus 4.8 · 1M context" },
  { key: "fable", label: "Fable", sub: "Fable 5" },
  { key: "sonnet", label: "Sonnet", sub: "Sonnet 5" },
  { key: "haiku", label: "Haiku", sub: "Haiku 4.5" },
];
const EFFORT_OPTS = [
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
  { key: "xhigh", label: "xHigh" },
  { key: "max", label: "Max" },
  { key: "ultracode", label: "Ultracode", sub: "this session only" },
];

function ConfigSheet() {
  const c = configSheet.value;
  if (c == null) return null;
  const close = () => (configSheet.value = null);
  const t = transcript.value;
  const current = c.kind === "model" ? t && t.model : t && t.effort;
  const opts = c.kind === "model" ? MODEL_OPTS : EFFORT_OPTS;
  const title = c.kind === "model" ? "Model" : "Reasoning effort";
  const apply = async (key) => {
    const sid = selectedId.value;
    close();
    const body = c.kind === "model" ? { model: key } : { effort: key };
    const data = await actionJson(`/sessions/${encodeURIComponent(sid)}/config`, body);
    if (data && data.line) notify(data.line); // Claude's verbatim confirmation (states the scope)
  };
  return html`
    <div class="scrim" onClick=${close}>
      <div class="sheet" onClick=${(e) => e.stopPropagation()}>
        <div class="sheetgroup">
          <div class="sheethead"><span class="name">${title}</span></div>
          ${opts.map(
            (o) => html`<button
              key=${o.key}
              class=${"cfgopt" + (o.key === current ? " current" : "")}
              onClick=${() => apply(o.key)}
            >
              <span class="cfglabel">${o.label}${o.sub ? html`<span class="cfgsub">${o.sub}</span>` : ""}</span>
              ${o.key === current ? html`<span class="cfgmark">✓</span>` : ""}
            </button>`,
          )}
          <button class="sheetcancel" onClick=${close}>Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function NoticeToast() {
  if (!notice.value) return null;
  return html`<div class="notice-toast">${notice.value}</div>`;
}

function CopiedToast() {
  if (!copied.value) return null;
  return html`<div class="copied-toast">✓ copied</div>`;
}

// Resume sync: iOS suspends backgrounded tabs and standalone PWAs and tears down the SSE
// socket. On return to foreground, immediately re-fetch (HTTP works even if the stream is
// stale) and re-establish the stream if it isn't OPEN. Covers tab/PWA resume-from-memory;
// `pageshow` (persisted) covers iOS's bfcache-style restore. Cold relaunch is handled by boot.
function resync() {
  if (!authed.value) return;
  tick.value = Date.now(); // ages froze while the tab was hidden — catch them up first
  refreshSessions();
  if (selectedId.value) refreshTranscript();
  if (openSubagent.value) refreshSubagent();
  // ALWAYS rebuild the stream on foreground — no readyState check. iOS can resume the
  // page with the socket long dead but no error ever delivered, so the EventSource
  // still claims OPEN; gating on readyState keeps that zombie and the app never hears
  // another broadcast. Reconnecting is one cheap request; a phantom-open stream is a
  // permanently silent app.
  connectStream();
}
// Advance the age clock once a minute while the page is visible — the labels' finest
// unit is minutes, so anything faster is wasted renders. A backgrounded tab stops
// ticking; `resync` catches it up on return.
let tickTimer;
function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => (tick.value = Date.now()), 60_000);
}
function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}
startTick();

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    startTick();
    resync();
  } else {
    stopTick();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) resync();
});

// --- boot: probe auth; the cookie (if present from a prior visit) authenticates ---
// The static boot spinner in index.html owns the screen during this probe. We delay
// Preact's first render() until the probe resolves so its first paint is already the
// list/login — never a second spinner that would replace the static one and restart
// its animation (the flicker). After boot, the in-app Spinner covers manual logins.
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  loadingAuth.value = false;
  render(html`<${App} />`, document.getElementById("app"));
}

// Deep link from a push notification: ?s=<sessionId>. Once the first snapshot
// lands, open that session (if it exists) and drop the query so a refresh/back
// doesn't re-trigger it.
function applyDeepLink() {
  const id = new URLSearchParams(location.search).get("s");
  if (!id) return;
  if (sessions.value.some((s) => s.id === id)) open(id);
  history.replaceState(null, "", location.pathname);
}

// Stale-while-revalidate boot: iOS evicts the backgrounded page constantly, so the most
// common interaction — reopen after minutes — used to boot from a blank spinner. Paint
// the last-persisted list immediately and let the auth probe below reconcile: a fresh
// snapshot replaces it in place, and a 401 flips authed → the login screen as before.
try {
  const saved = JSON.parse(localStorage.getItem("csm-sessions") || "null");
  if (Array.isArray(saved) && saved.length) {
    sessions.value = saved;
    authed.value = true;
    boot();
  }
} catch {
  /* corrupt/absent snapshot — normal spinner boot */
}

let bootTimeout;
refreshSessions()
  .then(() => {
    clearTimeout(bootTimeout);
    if (authed.value) {
      applyDeepLink();
      connectStream();
    }
  })
  .finally(boot);

// Timeout: if the auth probe hangs >20s, give up the spinner and show login/error.
bootTimeout = setTimeout(() => {
  if (!authed.value) error.value = "connection timeout";
  boot();
}, 20000);
