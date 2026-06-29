// CSM mobile bridge UI — Preact + signals + htm, no build step. Auth is the
// HttpOnly `csm` cookie (set by POST /auth); this file never touches the token
// after the one login POST, and never puts it in a URL.
import { h, render } from "preact";
import { useRef, useEffect, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";
import { Marked } from "marked";

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
const flash = signal(""); // transient action feedback in the detail view
const pendingSends = signal([]); // optimistic user bubbles awaiting transcript catch-up
const showNewSession = signal(false); // repo picker for launching a new session
const repos = signal(null); // null = loading, [] = loaded
const launching = signal(""); // repo name while waiting for a just-launched session to register
const menuText = signal(null); // long-pressed user message → action sheet (null = closed)
const loadingAuth = signal(true); // boot-time auth check + initial session load
const attachments = signal([]); // images staged in the composer: {blob, url} (object URLs)
const pendingImageSends = signal([]); // optimistic image bubbles awaiting transcript catch-up: {text, urls}
const connected = signal(true); // SSE stream health — false shows a "reconnecting" banner

let es = null;
// Byte cursor into the open session's transcript: the server returns turns appended
// since this offset, so each refresh ships only new turns. Reset to 0 on open/back so
// the next fetch pulls the full conversation. Module-level (not a signal) — pure
// bookkeeping, never rendered.
let txCursor = 0;

// Text of every user turn already in the transcript — used to retire optimistic
// bubbles once the real send lands (the transcript lags the pane by a few seconds).
function userTurnTexts(t) {
  const out = new Set();
  for (const turn of (t && t.turns) || []) {
    if (turn.role !== "user") continue;
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
    sessions.value = await r.json();
    authed.value = true;
  } catch {
    error.value = "bridge unreachable";
  }
}

async function refreshTranscript() {
  const id = selectedId.value;
  if (!id) return;
  try {
    const r = await fetch(`/sessions/${encodeURIComponent(id)}/transcript?since=${txCursor}`);
    if (!r.ok) return;
    const data = await r.json();
    if (id !== selectedId.value) return; // session switched mid-flight — drop stale response
    // `full` payloads (first open, or a reset/compacted log) replace; deltas append only
    // the new turns. Meta (usage, mode, statusline, openQuestion, approval, pendingTool)
    // is fresh in every response, so it comes straight from `data` either way.
    const prev = transcript.value;
    transcript.value =
      data.full || !prev ? data : { ...data, turns: [...prev.turns, ...data.turns] };
    if (typeof data.cursor === "number") txCursor = data.cursor;
    // Drop optimistic bubbles that have now materialized as real user turns.
    if (pendingSends.value.length) {
      const seen = userTurnTexts(transcript.value);
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

function connectStream() {
  if (es) es.close();
  es = new EventSource("/stream");
  // Re-snapshot on every (re)connect. EventSource reconnects on its own but never resends
  // state, so without this the list stays stale after a dropped socket reconnects.
  es.onopen = () => {
    connected.value = true;
    refreshSessions();
    if (selectedId.value) refreshTranscript();
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
      refreshSessions();
      if (msg.id === selectedId.value) refreshTranscript();
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

// Transient dock feedback that auto-hides, so an "✓ answered: …" toast doesn't linger.
// "…" (in-flight) stays until its result replaces it; everything else clears after 5s.
let flashTimer = null;
function setFlash(msg) {
  flash.value = msg;
  clearTimeout(flashTimer);
  if (msg && msg !== "…") flashTimer = setTimeout(() => (flash.value = ""), 5000);
}

// Send an action and SURFACE the result — the bridge gates answer/decision/message
// server-side and returns {ok,reason}; without this the UI looked identical whether
// the action worked or silently failed (e.g. the session had no live pane).
async function action(path, body, okMsg) {
  setFlash("…");
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
      setFlash(okMsg);
      refreshTranscript();
      refreshSessions();
      return true;
    }
    setFlash(`✗ ${data.reason || r.status}`);
    return false;
  } catch {
    setFlash("✗ bridge unreachable");
    return false;
  }
}

// Multipart sibling of action() for image uploads — identical result handling, but lets
// the browser set the multipart boundary (no JSON content-type header).
async function actionForm(path, formData, okMsg) {
  setFlash("…");
  try {
    const r = await fetch(path, { method: "POST", body: formData });
    let data = {};
    try {
      data = await r.json();
    } catch {}
    if (r.ok && data.ok !== false) {
      setFlash(okMsg);
      refreshTranscript();
      refreshSessions();
      return true;
    }
    setFlash(`✗ ${data.reason || r.status}`);
    return false;
  } catch {
    setFlash("✗ bridge unreachable");
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
  transcript.value = null;
  txCursor = 0; // pull the full conversation for the newly-opened session
  setFlash("");
  pendingSends.value = [];
  clearAttachments();
  refreshTranscript();
  markRead(id);
}

// Reading a session clears its unread glow: optimistically here, and on the bridge —
// which writes needsAttention:false to the shared state.json so the Mac's ⚡ clears too.
function markRead(id) {
  const s = sessions.value.find((x) => x.id === id);
  if (!s || !s.unread) return;
  sessions.value = sessions.value.map((x) => (x.id === id ? { ...x, unread: false } : x));
  fetch(`/sessions/${encodeURIComponent(id)}/read`, { method: "POST" }).catch(() => {});
}

function back() {
  selectedId.value = null;
  transcript.value = null;
  txCursor = 0;
  pendingSends.value = [];
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

async function copyMessage(text) {
  try {
    await navigator.clipboard.writeText(text);
    setFlash("✓ copied");
  } catch {
    setFlash("✗ copy failed");
  }
  menuText.value = null;
}

// Long-press detection for message actions. A single shared timer (only one press at a
// time); a move or release before the threshold cancels it, so it never fights swipes.
// The menu payload carries the message text + its rewind target (upCount = Up-presses
// from "(current)" in Claude's /rewind picker = totalUserMessages − thisMessageIndex).
let lpTimer = null;
const lpStart = (text, upCount, canCode) => () => {
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => (menuText.value = { text, upCount, canCode }), 450);
};
const lpCancel = () => clearTimeout(lpTimer);

async function rewind(mode) {
  const m = menuText.value;
  menuText.value = null;
  if (!m) return;
  await action(
    `/sessions/${encodeURIComponent(selectedId.value)}/rewind`,
    { upCount: m.upCount, text: m.text, mode },
    mode === "both" ? "✓ rewound code + conversation" : "✓ rewound conversation",
  );
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
// Secondary line: a meaningful summary if we have one; otherwise a real branch name.
// Never a filesystem path, a generic branch ("main"), or a repeat of the title — those
// are noise, so the row falls back to just the name (cleaner than echoing junk).
function subLine(s) {
  const sum = (s.summary || "").replace(/\s+/g, " ").trim();
  if (sum && sum !== listTitle(s) && !isNoisySub(sum)) return sum;
  return GENERIC_BRANCH.has(s.branch) ? "" : s.branch;
}

function modifiedMs(s) {
  const t = s.modified ? new Date(s.modified).getTime() : NaN;
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

// Concise "time since last activity" from the session's modified timestamp — the
// list column the Mac shows as token % (which says nothing about recency).
function formatAge(iso) {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(then)) return "";
  const sec = Math.max(0, (Date.now() - then) / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
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
  // group order otherwise buries a pending session in a low-priority repo (the #6 bug).
  const needsYou = list.filter((s) => s.pending);
  // Titles that recur get a short id so duplicates are distinguishable (e.g. two
  // "restore-session" rows that are otherwise identical).
  const titleCounts = {};
  for (const s of list) titleCounts[listTitle(s)] = (titleCounts[listTitle(s)] || 0) + 1;
  const renderRow = (s) => {
    const t = listTitle(s);
    const sub = subLine(s) || (titleCounts[t] > 1 ? s.id.slice(0, 8) : "");
    return html`
      <button type="button" class="row" key=${s.id} onClick=${() => open(s.id)}>
        <span class="dot" style=${dotStyle(s)}></span>
        <span class="grow">
          <span class="name">${t}</span>
          ${sub && html`<span class="sub">${sub}</span>`}
        </span>
        ${s.pending
          ? html`<span class="pendingbadge ${s.pending === "question" ? "q" : "a"}"
              >${s.pending === "question" ? "answer" : "approve"}</span>`
          : html`<span class="age">${formatAge(s.modified)}</span>`}
      </button>`;
  };
  // Repo groups exclude pending sessions (shown in the pinned block above).
  const groups = [];
  for (const s of list) {
    if (s.pending) continue;
    let g = groups.find((x) => x.repo === s.repo);
    if (!g) groups.push((g = { repo: s.repo, rows: [] }));
    g.rows.push(s);
  }
  // Static group order (pinned repos first, then alphabetical) so the list never
  // reshuffles when a session's status changes. Rows within a group stay sorted by
  // status/recency via orderedSessions above.
  groups.sort((a, b) => repoRank(a.repo) - repoRank(b.repo) || a.repo.localeCompare(b.repo));
  const attnCount = attentionSessions().length;
  // Header chip: blocked-on-you first (the loud red queue), else merely-unseen.
  const chip = needsYou.length
    ? { n: needsYou.length, label: "need you", target: needsYou[0] }
    : attnCount
      ? { n: attnCount, label: "unread", target: attentionSessions()[0] }
      : null;
  return html`
    <div class="screen">
      <div class="scroll">
        <div class="listhead">
          <h1>
            portkey
            ${chip &&
            html`<button class="attnchip" onClick=${() => chip.target && open(chip.target.id)}>
              ${chip.n} ${chip.label} ›
            </button>`}
          </h1>
          <button class="newbtn" onClick=${openNewSession} aria-label="New session">+</button>
        </div>
        ${error.value && html`<div class="err">${error.value}</div>`}
        ${launching.value && html`<div class="sub" style="padding:4px 4px 10px">launching ${launching.value}…</div>`}
        ${needsYou.length > 0 &&
        html`<div class="group" key="needs-you">
          <div class="repo needsyou">needs you</div>
          ${needsYou.map(renderRow)}
        </div>`}
        ${groups.map(
          (g) => html`
            <div class="group" key=${g.repo}>
              <div class="repo">${g.repo}</div>
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

// Longest common directory prefix (with trailing slash) of a set of absolute paths.
// Used to strip the shared parent from repo-picker rows so the repeated ~/Documents/
// prefix doesn't eat width or push the distinguishing tail off-screen.
function commonDirPrefix(paths) {
  if (!paths.length) return "";
  let p = paths[0];
  for (const s of paths) {
    while (!s.startsWith(p)) p = p.slice(0, -1);
    if (!p) return "";
  }
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i + 1) : "";
}

// New-session repo picker: tap a repo to launch `claude` in a new tmux window there
// (current branch — the wizard's simple case). Branch/worktree selection is TODO.
function NewSession() {
  const list = repos.value;
  // Show only the part of each path that differs from the shared parent; rows whose
  // remainder is just the repo name (already the title) drop the redundant sub line.
  const prefix = commonDirPrefix((list || []).map((r) => r.path));
  return html`
    <div class="screen">
      <div class="listhead">
        <button class="iconbtn" onClick=${() => (showNewSession.value = false)} aria-label="Back">‹</button>
        <h1 style="margin:0">new session</h1>
      </div>
      <div class="scroll">
        ${error.value && html`<div class="err">${error.value}</div>`}
        ${list === null && html`<div class="sub" style="padding:8px">loading repos…</div>`}
        ${list && list.length === 0 && html`<div class="sub" style="padding:8px">no repos found</div>`}
        ${list &&
        list.map((r) => {
          const rel = r.path.slice(prefix.length);
          const sub = rel && rel !== r.name ? rel : "";
          return html`
            <button type="button" class="row" key=${r.path} onClick=${() => launchSession(r)}>
              <span class="dot" style="color:var(--mint)">+</span>
              <span class="grow">
                <span class="name">${r.name}</span>
                ${sub && html`<span class="sub">${sub}</span>`}
              </span>
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
          ? html`<div class="bubble assistant md" dangerouslySetInnerHTML=${{ __html: md(shown) }}></div>`
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
      const arg = input.command || input.file_path || input.pattern || "";
      els.push(html`<div class="tool">▸ ${b.name || "tool"}${arg && html` <span class="arg">${arg}</span>`}</div>`);
    }
  }
  return els.length ? html`<div class="turn">${els}</div>` : null;
}

function QuestionCard({ q }) {
  // multiSelect: accumulate a selection set + explicit Submit (the server takes an index
  // array). single-select: tap an option to answer immediately. The options list scrolls
  // inside a capped card so a many-option question never clips off-screen (#2).
  const multi = q.multiSelect;
  const [sel, setSel] = useState(() => new Set());
  const answer = (selection, label) =>
    action(`/sessions/${encodeURIComponent(selectedId.value)}/answer`, { selection }, `✓ answered${label ? `: ${label}` : ""}`);
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
              onClick=${() => (multi ? toggle(i) : answer(i, o.label))}
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
        onClick=${() => answer([...sel].sort((a, b) => a - b))}
      >
        Submit${sel.size ? ` (${sel.size})` : ""}
      </button>`}
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
  function decide(decision) {
    action(`/sessions/${encodeURIComponent(selectedId.value)}/decision`, { decision }, `✓ ${decision}`);
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
function Composer() {
  const ref = useRef(null);
  const fileRef = useRef(null);
  function grow() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
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
    if (items.length === 0) {
      pendingSends.value = [...pendingSends.value, text];
      const ok = await action(`/sessions/${encodeURIComponent(sid)}/message`, { text }, "✓ sent");
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
    const ok = await actionForm(`/sessions/${encodeURIComponent(sid)}/message`, fd, "✓ sent");
    if (!ok) {
      // Restore so nothing is silently lost; keep the URLs alive for the retry.
      pendingImageSends.value = pendingImageSends.value.filter((e) => e !== entry);
      attachments.value = items;
      el.value = text;
      grow();
    }
  }
  return html`
    <div class="composerwrap">
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
        <button class="attach" onClick=${() => fileRef.current && fileRef.current.click()} aria-label="Attach image">＋</button>
        <textarea
          ref=${ref}
          rows="1"
          placeholder="Message…"
          onInput=${grow}
          onKeyDown=${(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        ></textarea>
        <button class="send" onClick=${send} aria-label="Send">↑</button>
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

function Detail() {
  const t = transcript.value;
  const session = sessions.value.find((s) => s.id === selectedId.value);
  const status = session ? session.status : "";
  const turns = t ? t.turns : []; // full conversation — no slicing (md() is cached)
  const question = t && t.openQuestion;
  const approval = t && t.approval;
  // While blocked on a question/approval, the structured answer UI takes the dock —
  // otherwise it's the free-text composer (this is the "replace the message box with
  // the question/answers" behavior).
  const blocked = question || approval;

  const rootRef = useRef(null); // the Detail screen, translated during the back-swipe
  const scrollRef = useRef(null); // the thread is the ONLY scroll region (app-shell layout)
  const follow = useRef(true); // auto-scroll only while the user is near the bottom
  const lastId = useRef(null);
  const drag = useRef({ x: 0, y: 0, active: false, dx: 0, decided: false });

  // Attention-jump button: count of OTHER blocked sessions (the queue minus this one).
  const otherAttention = attentionSessions().filter((s) => s.id !== selectedId.value).length;

  // Interactive swipe-right-to-go-back (iOS-style): the screen tracks the finger, then
  // on release either commits to the list (past threshold) or springs home. Only a
  // clearly horizontal-right drag engages, so it never steals vertical scrolling. The
  // touchmove listener is attached non-passively (below) so it can preventDefault and
  // own the gesture — otherwise the browser's own pan leaves state that eats the next
  // tap on the list.
  function onTouchStart(e) {
    const p = e.changedTouches[0];
    // Remember the nearest horizontally-scrollable ancestor under the finger (e.g. a
    // code block with overflow-x). A right-swipe inside it should scroll its content,
    // not trigger back — unless it's already at its left edge (nothing left to reveal).
    drag.current = { x: p.clientX, y: p.clientY, active: false, dx: 0, decided: false, hScroller: hScrollerAt(e.target) };
    if (rootRef.current) rootRef.current.style.transition = "none";
  }
  function onTouchEnd() {
    const el = rootRef.current;
    if (!el || !drag.current.active) return;
    drag.current.active = false;
    if (drag.current.dx > Math.min(innerWidth * 0.32, 140)) {
      // Follow through: carry the screen the rest of the way off the right edge, THEN
      // unmount to the list (on transitionend) so it reads as one continuous motion
      // instead of snapping away mid-swipe. The double-tap that forced the old instant
      // back() came from the passive-listener residual pan, now fixed via non-passive
      // preventDefault — so the list mounts only after the slide and stays tappable.
      el.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out";
      el.style.transform = `translateX(${innerWidth}px)`;
      el.style.opacity = "0";
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        back();
      };
      el.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 240); // fallback if transitionend is dropped
      return;
    }
    el.style.transition = "transform 0.2s ease-out, opacity 0.2s ease-out"; // spring home
    el.style.transform = "";
    el.style.opacity = "";
  }

  // Non-passive touchmove so preventDefault works — owns the horizontal gesture.
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
        // Defer to an inner horizontal scroller that can still scroll right (revealing its
        // left side). Only when it's at scrollLeft 0 does the back gesture take over.
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
  }, []);

  // Track whether we're pinned to the bottom of the thread; stop following on scroll-up.
  function onThreadScroll() {
    const el = scrollRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
      <div class="scroll thread" ref=${scrollRef} onScroll=${onThreadScroll}>
        ${!t && html`<div class="sub" style="padding:8px">loading…</div>`}
        ${(() => {
          // Per user turn: upCount = Up-presses to reach it in the /rewind picker
          // = (total user turns) − (its index among user turns); canCode = whether any
          // file-editing tool ran after it (so we offer code-restore only when there's
          // code to restore — Bash edits aren't checkpointed, matching Claude).
          const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
          const n = turns.length;
          const editAfter = new Array(n).fill(false);
          let sawEdit = false;
          for (let i = n - 1; i >= 0; i--) {
            editAfter[i] = sawEdit;
            if ((turns[i].content || []).some((b) => b.type === "tool_use" && EDIT_TOOLS.has(b.name))) {
              sawEdit = true;
            }
          }
          const totalUsers = turns.filter((x) => x.role === "user").length;
          let uSeen = 0;
          return turns.map((turn, i) => {
            const up = turn.role === "user" ? totalUsers - uSeen++ : 0;
            return html`<${Turn} key=${i} turn=${turn} upCount=${up} canCode=${editAfter[i]} />`;
          });
        })()}
        ${pendingSends.value.map((text, i) => html`<div class="bubble user pending" key=${`p${i}`}>${text}</div>`)}
        ${pendingImageSends.value.map(
          (e, i) => html`<div class="bubble user pending imgbubble" key=${`pi${i}`}>
            <div class="bubthumbs">${e.urls.map((u) => html`<img src=${u} alt="" key=${u} />`)}</div>
            ${e.text && html`<div>${e.text}</div>`}
          </div>`,
        )}
        ${t && t.pendingTool && !blocked && html`<${RunningTool} tool=${t.pendingTool} />`}
        ${status === "running" && !blocked && html`<div class="typing">working…</div>`}
      </div>
      <div class="dock">
        <div class="dock-inner">
          ${flash.value && html`<div class="flash">${flash.value}</div>`}
          <div class="navbar">
            <button class="iconbtn" onClick=${back} aria-label="Back to sessions">‹</button>
            <div class="navtitle">${session ? session.label || session.repo : "session"}</div>
            <span class="meta">
              ${status && html`<span style=${`color:${DOT_COLOR[status] ?? "var(--dim)"}`}>${DOT[status]}</span>`}
              ${!statusline &&
              usage &&
              html`<span class="usage" style=${`color:${usageColor(usage.percent)}`}>${usage.percent}%</span>`}
            </span>
            ${otherAttention > 0 &&
            html`<button class="attn" onClick=${gotoNextAttention} aria-label="Next session needing attention">
              ⏸ ${otherAttention} ›
            </button>`}
          </div>
          ${(statusline || mode) &&
          html`<div class="statusbar">
            ${mode && html`<span class="modebadge" style=${`color:${modeColor}`}>${mode}</span>`}
            ${statusline && html`<span class="sltext">${statusline}</span>`}
          </div>`}
          ${question
            ? html`<${QuestionCard} q=${question} />`
            : approval
              ? html`<${ApprovalCard} approval=${approval} />`
              : html`<${Composer} />`}
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
          ${!busy &&
          html`<button class="danger" onClick=${() => rewind("conversation")}>Rewind conversation to here</button>`}
          ${!busy &&
          m.canCode &&
          html`<button class="danger" onClick=${() => rewind("both")}>Rewind code + conversation</button>`}
          ${busy && html`<div class="sheethint">Rewind is available at the prompt.</div>`}
        </div>
        <button class="sheetgroup sheetcancel" onClick=${close}>Cancel</button>
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
  return html`${!connected.value && html`<div class="offline">reconnecting…</div>`}${screen}<${ActionSheet} />`;
}

// Resume sync: iOS suspends backgrounded tabs and standalone PWAs and tears down the SSE
// socket. On return to foreground, immediately re-fetch (HTTP works even if the stream is
// stale) and re-establish the stream if it isn't OPEN. Covers tab/PWA resume-from-memory;
// `pageshow` (persisted) covers iOS's bfcache-style restore. Cold relaunch is handled by boot.
function resync() {
  if (!authed.value) return;
  refreshSessions();
  if (selectedId.value) refreshTranscript();
  if (!es || es.readyState !== 1 /* OPEN */) connectStream();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resync();
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

let bootTimeout;
refreshSessions()
  .then(() => {
    clearTimeout(bootTimeout);
    if (authed.value) connectStream();
  })
  .finally(boot);

// Timeout: if the auth probe hangs >20s, give up the spinner and show login/error.
bootTimeout = setTimeout(() => {
  if (!authed.value) error.value = "connection timeout";
  boot();
}, 20000);
