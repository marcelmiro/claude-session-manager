/**
 * CSM Bridge (Impl #3) — a thin HTTP/SSE transport over the headless `core/` API
 * so an iPhone (over Tailscale) can see sessions, read transcripts, approve tools,
 * answer questions, and send messages. Adds NO Claude-wrapping logic: every route
 * delegates to an existing `core/` function. Headless like `monitor.ts` — imports
 * `core/*` only, never `ui/`/`blessed`.
 *
 * Security posture: bind fail-closed (loopback / tailnet only); a static bearer
 * token, exchanged once via `POST /auth` for an HttpOnly cookie so the token never
 * rides in a URL. `/decision`, `/message`, `/answer` are remote-code-execution by
 * design — the tailnet bind is the wall, the token is defense-in-depth.
 */

import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { discoverSessions } from "../core/sessions";
import {
  getTranscript,
  sendMessage,
  answerSessionQuestion,
  createSession,
  rewindSession,
  archiveSession,
  resolveSessionPane,
  readPaneStatusline,
  type SendResult,
} from "../core/session-api";
import { discoverRepos } from "../core/git";
import { loadConfig, PATHS } from "../core/config";
import { listPendingApprovals, decideApproval } from "../core/approval";
import { watchEvents } from "../core/watch";
import { EVENTS_DIR, pendingToolCall } from "../core/hook-events";
import {
  loadNameCache,
  saveNameCache,
  generateAIName,
  acquireNamingLock,
  releaseNamingLock,
  type NameCache,
} from "../core/names";
import { buildSessionLabel } from "../core/session-label";
import { loadState, saveState } from "../core/state";
import { fixtureData } from "./fixtures";
import type { Session } from "../types";

const PUBLIC_DIR = `${import.meta.dir}/public`;

// Demo/test mode: serve canned data (fixtures.ts) instead of querying core/, so the UI
// renders deterministically with no live sessions. Auth + static serving stay real.
const FIXTURES = !!process.env.CSM_BRIDGE_FIXTURES;

// Explicit allow-map: request path → file under public/. Never join a raw
// url.pathname onto PUBLIC_DIR (path traversal). Unlisted paths → 404.
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/manifest.json": "manifest.json",
  "/icon-512.png": "icon-512.png",
  "/apple-touch-icon.png": "apple-touch-icon.png",
  "/vendor/preact.mjs": "vendor/preact.mjs",
  "/vendor/hooks.mjs": "vendor/hooks.mjs",
  "/vendor/signals-core.mjs": "vendor/signals-core.mjs",
  "/vendor/signals.mjs": "vendor/signals.mjs",
  "/vendor/htm.mjs": "vendor/htm.mjs",
  "/vendor/marked.mjs": "vendor/marked.mjs",
};

// ---------------------------------------------------------------------------
// Auth — sha256 + timingSafeEqual (equal-length digests → never throws, no leak)
// ---------------------------------------------------------------------------

let rawToken = "";
let tokenDigest: Buffer;

function tokenMatches(presented: string | null | undefined): boolean {
  if (!presented) return false;
  const digest = createHash("sha256").update(presented).digest();
  return timingSafeEqual(tokenDigest, digest);
}

function cookieToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === "csm") return part.slice(eq + 1).trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function staticResponse(rel: string): Response {
  const type = rel.endsWith(".html")
    ? "text/html;charset=utf-8"
    : rel.endsWith(".mjs") || rel.endsWith(".js")
      ? "text/javascript;charset=utf-8"
      : rel.endsWith(".json")
        ? "application/manifest+json;charset=utf-8"
        : rel.endsWith(".png")
          ? "image/png"
          : "application/octet-stream";
  // Vendored libs are immutable; the app's own HTML/JS changes as we iterate, so
  // forbid stale caching of it (mobile Safari otherwise serves an old bundle).
  const cache = rel.startsWith("vendor/") ? "public, max-age=86400" : "no-cache";
  return new Response(Bun.file(`${PUBLIC_DIR}/${rel}`), {
    headers: { "content-type": type, "cache-control": cache },
  });
}

function sendResult(r: SendResult): Response {
  return json(r, r.ok ? 200 : 409);
}

// ---------------------------------------------------------------------------
// Image uploads — written to PATHS.uploads, then pasted into the pane by sendMessage.
// ---------------------------------------------------------------------------

// Allow-list of accepted image types → file extension. The filename is always our own
// randomUUID (never the client's) so there's no path-traversal surface.
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Persist uploaded image files; returns absolute paths, or a `bad-image` error. */
async function saveUploadedImages(files: File[]): Promise<{ paths: string[] } | { error: "bad-image" }> {
  const paths: string[] = [];
  for (const f of files) {
    const ext = IMAGE_EXT[f.type];
    if (!ext) return { error: "bad-image" };
    const dest = `${PATHS.uploads}/${randomUUID()}.${ext}`;
    await Bun.write(dest, await f.arrayBuffer()); // Bun.write creates the parent dir
    paths.push(dest);
  }
  return { paths };
}

/** Best-effort prune of upload files older than 24h (the bytes live in the JSONL after submit). */
function pruneOldUploads(): void {
  try {
    const now = Date.now();
    for (const name of readdirSync(PATHS.uploads)) {
      const p = `${PATHS.uploads}/${name}`;
      try {
        if (now - statSync(p).mtimeMs > UPLOAD_MAX_AGE_MS) rmSync(p, { force: true });
      } catch {
        // file vanished mid-scan — ignore
      }
    }
  } catch {
    // uploads dir not created yet — nothing to prune
  }
}

// ---------------------------------------------------------------------------
// /sessions — projection (drop the large lastCapture blob), 1s TTL cache so SSE
// reconnect storms don't fan out into concurrent ps/tmux subprocess swarms.
// ---------------------------------------------------------------------------

// A "main"/"master" branch tells you nothing about a session; for those, fall
// back to the conversation summary so the phone shows what each session is about.
const GENERIC_BRANCH = new Set(["main", "master", "develop", "dev", ""]);

function snippet(text: string, max = 80): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Primary display label: AI name / ticket / branch (via buildSessionLabel), but
 * when that degrades to a bare generic branch (`main`), prefer a summary or
 * first-prompt snippet — the only signal that distinguishes those sessions.
 */
function sessionLabel(s: Session): string {
  const base = buildSessionLabel(s);
  if (base === s.branch && GENERIC_BRANCH.has(s.branch)) {
    const snip = snippet(s.summary) || snippet(s.firstPrompt);
    if (snip) return snip;
  }
  return base;
}

function projectSession(s: Session, approvalIds: Set<string>, unread: boolean) {
  // Pending = blocked-on-USER, sourced from the hook log (not status): discovery can
  // mislabel a live blocked session as `archived`, but it must stay reachable from the
  // phone. ONLY a real question or a real awaiting-decision approval counts — an
  // in-flight auto-approved tool is NOT pending (that was the false bash-approval bug).
  const pending = pendingToolCall(s.id);
  const pendingKind =
    pending?.name === "AskUserQuestion" && pending.question
      ? "question"
      : approvalIds.has(s.id)
        ? "approval"
        : null;
  return {
    id: s.id,
    repo: s.repo,
    branch: s.branch,
    status: s.status,
    name: s.name,
    label: sessionLabel(s),
    pending: pendingKind,
    // Unread = the monitor's ⚡ (needsAttention from state.json): a turn that completed
    // or a block that you haven't seen on Mac OR phone yet. Drives the glow + header.
    unread,
    contextPercent: s.contextPercent,
    messageCount: s.messageCount,
    summary: s.summary,
    statusSource: s.statusSource,
    modified: s.modified.toISOString(),
  };
}

/** PaneIds the monitor currently flags as needing attention (state.json ⚡). */
async function unreadPanes(): Promise<Set<string>> {
  const state = await loadState();
  const out = new Set<string>();
  for (const [paneId, st] of Object.entries(state.sessions)) {
    if (st.needsAttention) out.add(paneId);
  }
  return out;
}

/**
 * Clear a session's unread flag (read-on-open from the phone) by writing
 * needsAttention:false for its live pane into the shared state.json. The monitor
 * re-reads disk each cycle and preserves prior flags, so this stays cleared until the
 * next real transition — clearing the ⚡ on the Mac window name too. Surgical: flips one
 * pane's flag, never rewrites the attention set (safe from a background process).
 */
async function markSessionRead(sessionId: string): Promise<void> {
  const paneId = await resolveSessionPane(sessionId);
  if (!paneId) return;
  const state = await loadState();
  const entry = state.sessions[paneId];
  if (!entry?.needsAttention) return;
  entry.needsAttention = false;
  delete entry.attentionType;
  state.lastUpdatedBy = "bridge";
  state.lastUpdatedAt = Date.now();
  await saveState(state);
  sessionsCache = null;
  broadcast({ type: "session-changed", id: sessionId });
}

// Repos available for a new session: active-session repos (worktrees deduped to base)
// plus the configured repoPaths, exactly as the TUI wizard sources them.
async function reposPayload(): Promise<Array<{ name: string; path: string }>> {
  const cfg = await loadConfig();
  const { sessions } = await discoverSessions({});
  const sessionRepos = sessions
    .filter((s) => s.repoPath)
    .map((s) => ({ name: s.repo, path: s.repoPath }));
  const repos = await discoverRepos(sessionRepos, cfg.repoPaths ?? [], cfg.priorityRepos ?? []);
  return repos.map((r) => ({ name: r.name, path: r.path }));
}

let sessionsCache: { ts: number; value: unknown } | null = null;

async function sessionsPayload(): Promise<unknown> {
  const now = Date.now();
  if (sessionsCache && now - sessionsCache.ts < 1000) return sessionsCache.value;
  const nameCache = await loadNameCache();
  const { sessions } = await discoverSessions({ nameMap: nameCache.names });
  const approvalIds = new Set(listPendingApprovals().map((a) => a.sessionId));
  const unread = await unreadPanes();
  const tracked = sessions.filter((s) => s.id); // untracked panes (no id) are unaddressable
  const value = tracked.map((s) => {
    // nameMap only RESOLVES ids in discoverSessions; the cached name (same source
    // as tmux window names) must be applied here, mirroring the TUI.
    s.name = nameCache.names[s.id] || s.name;
    return projectSession(s, approvalIds, !!(s.tmuxPane && unread.has(s.tmuxPane.paneId)));
  });
  sessionsCache = { ts: now, value };
  maybeGenerateNames(tracked, nameCache); // fire-and-forget; refreshes via SSE
  return value;
}

// --- Background AI naming -------------------------------------------------
// Generate tmux-style names for sessions the cache hasn't named yet, reusing the
// monitor's generateAIName + the shared name cache. Lock-coordinated so the bridge
// and monitor never double-name; failed attempts back off for NAMING_SKIP_TTL.

let namingActive = false;
const namingSkip = new Map<string, number>(); // sessionId → last failed-attempt ts
const NAMING_SKIP_TTL = 5 * 60_000;
const NAMING_BATCH = 3; // keep concurrent `claude -p` low so cold starts don't starve past the timeout

function maybeGenerateNames(sessions: Session[], cache: NameCache): void {
  if (namingActive) return;
  const now = Date.now();
  const todo = sessions
    .filter(
      (s) =>
        s.id &&
        !cache.names[s.id] &&
        now - (namingSkip.get(s.id) ?? 0) > NAMING_SKIP_TTL &&
        (s.firstPrompt || s.summary || s.lastPrompt),
    )
    .slice(0, NAMING_BATCH);
  if (todo.length === 0) return;

  namingActive = true;
  void (async () => {
    try {
      if (!(await acquireNamingLock())) return; // monitor is naming — skip this cycle
      const named: Array<[string, string]> = [];
      await Promise.all(
        todo.map(async (s) => {
          const name = await generateAIName(s.firstPrompt, s.summary, s.branch, s.lastPrompt);
          if (name) named.push([s.id, name]);
          else namingSkip.set(s.id, Date.now());
        }),
      );
      if (named.length > 0) {
        // Reload under the lock so we merge onto any names the monitor wrote meanwhile.
        const fresh = await loadNameCache();
        for (const [id, name] of named) fresh.names[id] = name;
        await saveNameCache(fresh);
        sessionsCache = null; // force re-projection with the new names
        for (const [id] of named) broadcast({ type: "session-changed", id });
      }
    } catch {
      // naming is best-effort — never let it crash the server
    } finally {
      await releaseNamingLock();
      namingActive = false;
    }
  })();
}

// ---------------------------------------------------------------------------
// SSE — one stream per client; a single watchEvents subscription fans changes
// out to all. Heartbeat every 15s (iOS drops idle background sockets ~30s).
// ---------------------------------------------------------------------------

const clients = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();

function pushAll(frame: Uint8Array): void {
  for (const c of clients) {
    try {
      c.enqueue(frame);
    } catch {
      clients.delete(c); // controller closed between cancel and broadcast
    }
  }
}

function broadcast(obj: unknown): void {
  pushAll(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
}

function streamResponse(): Response {
  let self: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      clients.add(controller);
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      clients.delete(self);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // --- Public: static shell (carries no secret/data) ---
  if (method === "GET" && path in STATIC) return staticResponse(STATIC[path]!);

  // --- Public: token → cookie exchange (the only place the token is accepted) ---
  if (method === "POST" && path === "/auth") {
    const body = (await req.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== "string" || !tokenMatches(body.token)) return json({ ok: false }, 401);
    return json({ ok: true }, 200, {
      "set-cookie": `csm=${rawToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
    });
  }

  // --- Everything below is protected: valid csm cookie required ---
  if (!tokenMatches(cookieToken(req))) return json({ ok: false }, 401);

  // --- Demo/test mode: canned data for the GET/action routes (`/stream` falls through) ---
  if (FIXTURES) {
    const fixture = fixtureData(method, path);
    if (fixture !== undefined) return json(fixture);
  }

  if (method === "GET" && path === "/sessions") return json(await sessionsPayload());
  if (method === "GET" && path === "/pending") return json(listPendingApprovals());
  if (method === "GET" && path === "/stream") return streamResponse();
  if (method === "GET" && path === "/repos") return json(await reposPayload());

  // New session: launch `claude` in a new tmux window for the chosen repo (TUI `n`).
  if (method === "POST" && path === "/sessions/new") {
    const body = (await req.json().catch(() => ({}))) as { path?: unknown; name?: unknown };
    if (typeof body.path !== "string" || typeof body.name !== "string") {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    return sendResult(await createSession(body.path, body.name));
  }

  const transcript = path.match(/^\/sessions\/([^/]+)\/transcript$/);
  if (method === "GET" && transcript) {
    const id = decodeURIComponent(transcript[1]!);
    // Always returns the full active branch (reconstructed leaf→root) — a rewind can shrink
    // the conversation, so an append-only delta would leak abandoned-branch turns.
    const tx = await getTranscript(id);
    // Real awaiting-decision approval (blocking hook), NOT the in-flight pendingTool —
    // so Allow/Deny only appears when a decision is genuinely required.
    const approval = listPendingApprovals().find((a) => a.sessionId === id) ?? null;
    // The live statusline + permission mode, scraped from the pane (the only faithful
    // source for the user's custom statusline and the auto/plan mode).
    const pane = await resolveSessionPane(id);
    const statusline = pane ? await readPaneStatusline(pane) : {};
    return json({ ...tx, approval, ...statusline });
  }

  const decision = path.match(/^\/sessions\/([^/]+)\/decision$/);
  if (method === "POST" && decision) {
    const body = (await req.json().catch(() => ({}))) as { decision?: unknown; reason?: unknown };
    if (body.decision !== "allow" && body.decision !== "deny") {
      return json({ ok: false, reason: "bad-decision" }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    decideApproval(decodeURIComponent(decision[1]!), body.decision, reason);
    return json({ ok: true });
  }

  const rewind = path.match(/^\/sessions\/([^/]+)\/rewind$/);
  if (method === "POST" && rewind) {
    const body = (await req.json().catch(() => ({}))) as {
      upCount?: unknown;
      text?: unknown;
      mode?: unknown;
    };
    if (
      typeof body.upCount !== "number" ||
      typeof body.text !== "string" ||
      (body.mode !== "conversation" && body.mode !== "both")
    ) {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    return sendResult(await rewindSession(decodeURIComponent(rewind[1]!), body.upCount, body.text, body.mode));
  }

  const message = path.match(/^\/sessions\/([^/]+)\/message$/);
  if (method === "POST" && message) {
    const id = decodeURIComponent(message[1]!);
    // Multipart = a message with image attachments; JSON = the original text-only path.
    if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
      const form = await req.formData().catch(() => null);
      if (!form) return json({ ok: false, reason: "bad-form" }, 400);
      const text = typeof form.get("text") === "string" ? (form.get("text") as string) : "";
      const files = form.getAll("image").filter((v): v is File => v instanceof File);
      if (!text.trim() && files.length === 0) return json({ ok: false, reason: "empty" }, 400);
      const saved = await saveUploadedImages(files);
      if ("error" in saved) return json({ ok: false, reason: saved.error }, 400);
      pruneOldUploads();
      return sendResult(await sendMessage(id, text, saved.paths));
    }
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string") return json({ ok: false, reason: "bad-text" }, 400);
    return sendResult(await sendMessage(id, body.text));
  }

  const answer = path.match(/^\/sessions\/([^/]+)\/answer$/);
  if (method === "POST" && answer) {
    const body = (await req.json().catch(() => ({}))) as { selection?: unknown };
    const sel = body.selection;
    const valid = typeof sel === "number" || (Array.isArray(sel) && sel.every((n) => typeof n === "number"));
    if (!valid) return json({ ok: false, reason: "bad-selection" }, 400);
    return sendResult(await answerSessionQuestion(decodeURIComponent(answer[1]!), sel as number | number[]));
  }

  // Mark read (cleared the unread glow on open) — clears the monitor's ⚡ on both devices.
  const read = path.match(/^\/sessions\/([^/]+)\/read$/);
  if (method === "POST" && read) {
    await markSessionRead(decodeURIComponent(read[1]!));
    return json({ ok: true });
  }

  // Archive (kill the tmux pane, ending the Claude process; conversation stays resumable).
  const archive = path.match(/^\/sessions\/([^/]+)\/archive$/);
  if (method === "POST" && archive) {
    const result = await archiveSession(decodeURIComponent(archive[1]!));
    sessionsCache = null; // force re-projection — the killed pane drops from the next list
    broadcast({ type: "session-changed", id: decodeURIComponent(archive[1]!) });
    return sendResult(result);
  }

  return json({ ok: false, reason: "not-found" }, 404);
}

// ---------------------------------------------------------------------------
// Bind — fail-closed to loopback / tailnet (Tailscale CGNAT 100.64.0.0/10)
// ---------------------------------------------------------------------------

function isAllowedHost(host: string): boolean {
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // tailnet CGNAT
  return false;
}

export function startBridge(): void {
  const host = process.env.CSM_BRIDGE_HOST ?? "127.0.0.1";
  const port = Number(process.env.CSM_BRIDGE_PORT ?? "8473");
  rawToken = process.env.CSM_BRIDGE_TOKEN ?? "";

  if (!rawToken) {
    throw new Error("CSM_BRIDGE_TOKEN is required — refusing to start without a token (fail-closed)");
  }
  if (!isAllowedHost(host)) {
    throw new Error(
      `CSM_BRIDGE_HOST=${host} is not loopback or tailnet (100.64.0.0/10) — refusing to bind (fail-closed)`,
    );
  }
  tokenDigest = createHash("sha256").update(rawToken).digest();

  if (!existsSync(EVENTS_DIR)) {
    console.error("EVENTS_DIR not found: live push disabled; restart bridge after csm setup");
  }
  watchEvents((id) => broadcast({ type: "session-changed", id }));
  setInterval(() => pushAll(encoder.encode(":\n\n")), 15_000);

  // Sync the unread/⚡ set from the monitor (which rewrites state.json ~every 3s). Only
  // broadcast when the set of needs-attention panes actually changes, so a Mac-side
  // focus-clear or a fresh attention reaches the phone within ~3s without refresh spam.
  let lastUnreadKey: string | null = null;
  setInterval(async () => {
    try {
      const state = await loadState();
      const key = Object.entries(state.sessions)
        .filter(([, st]) => st.needsAttention)
        .map(([pane]) => pane)
        .sort()
        .join(",");
      if (lastUnreadKey === null) {
        lastUnreadKey = key; // first tick: establish baseline, don't broadcast
        return;
      }
      if (key !== lastUnreadKey) {
        lastUnreadKey = key;
        sessionsCache = null; // force re-projection with the new unread flags
        broadcast({ type: "session-changed" });
      }
    } catch {
      // state.json missing/locked mid-write — try again next tick
    }
  }, 3000);

  Bun.serve({
    hostname: host,
    port,
    maxRequestBodySize: 32 * 1024 * 1024, // backstop for image uploads (client downscales first)
    idleTimeout: 255, // long-lived SSE; heartbeat (15s) keeps it active well within
    async fetch(req) {
      try {
        return await route(req);
      } catch {
        return json({ ok: false, reason: "internal-error" }, 500);
      }
    },
  });
  console.error(`csm bridge listening on http://${host}:${port}${FIXTURES ? " (fixtures mode — canned data)" : ""}`);
}
