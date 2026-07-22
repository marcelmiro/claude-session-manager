/**
 * CSM Bridge (Impl #3) — a thin HTTP/SSE transport over the headless `core/` API
 * so an iPhone (over Tailscale) can see sessions, read transcripts, approve tools,
 * answer questions, and send messages. Adds NO Claude-wrapping logic: every route
 * delegates to an existing `core/` function. Headless like `monitor.ts` — imports
 * `core/*` only, never `ui/`/`blessed`.
 *
 * Security posture: bind fail-closed (loopback / tailnet only); a static bearer
 * token, exchanged once via `POST /auth` for an HttpOnly cookie so the token never
 * rides in a URL. `/decision`, `/message`, `/answer`, `/config` are remote-code-execution
 * by design (`/config` is allowlist-clamped) — the tailnet bind is the wall, the token is
 * defense-in-depth.
 */

import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync, rmSync, openSync, closeSync, unlinkSync, mkdirSync } from "node:fs";
import { relative } from "node:path";
import { discoverSessions } from "../core/sessions";
import {
  getTranscript,
  getSubagentTranscript,
  listSubagents,
  pendingToolFields,
  transcriptRevAt,
  sendMessage,
  answerSessionQuestion,
  clarifySessionQuestion,
  createSession,
  restoreState,
  restoreSession,
  rewindSession,
  archiveSession,
  interruptSession,
  resolveSessionPane,
  readPaneStatusline,
  decideAttachedApproval,
  setSessionModelEffort,
  isModelArg,
  isEffortArg,
  type SendResult,
} from "../core/session-api";
import { nativeStatus } from "../core/session-state";
import { pendingScriptsAt } from "../core/background-tasks";
import { resolveTranscriptPath } from "../core/last-turn";
import { homedir } from "os";
import { discoverRepos, getBaseRepoPath, compareRepos } from "../core/git";
import { listSlashCommands } from "../core/skills";
import { repoRootForSession, safeRepoPath, fileDiff, branchChanges } from "../core/repo-files";
import { branchPullRequest, type PullRequestInfo } from "../core/pull-request";
import { recoverWorktreeTranscript } from "../core/recover";
import { loadConfig, PATHS } from "../core/config";
import { listPendingApprovals, decideApproval } from "../core/approval";
import { markPortkeySource } from "../core/input-source";
import {
  CONSUMERS_DIR,
  isValidDeviceId,
  getVapidPublicKey,
  saveSubscription,
  getSubscription,
} from "../core/web-push";
import { watchEvents } from "../core/watch";
import { EVENTS_DIR, pendingToolCall } from "../core/hook-events";
import { capturePane, listPanes } from "../core/tmux";
import { isPermissionPrompt, sessionActivityAt } from "../core/status";
import {
  loadNameCache,
  saveNameCache,
  generateAIName,
  getSessionName,
  acquireNamingLock,
  releaseNamingLock,
  type NameCache,
} from "../core/names";
import { buildSessionLabel, disambiguateNames } from "../core/session-label";
import { loadState, saveState } from "../core/state";
import { loadAllSessions, filterAndRankEntries, type SearchEntry } from "../core/search";
import { fixtureData } from "./fixtures";
import type { RestoreState, Session } from "../types";

const PUBLIC_DIR = `${import.meta.dir}/public`;

// Demo/test mode: serve canned data (fixtures.ts) instead of querying core/, so the UI
// renders deterministically with no live sessions. Auth + static serving stay real.
const FIXTURES = !!process.env.CSM_BRIDGE_FIXTURES;

// Explicit allow-map: request path → file under public/. Never join a raw
// url.pathname onto PUBLIC_DIR (path traversal). Unlisted paths → 404.
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/sw.js": "sw.js",
  // Shared with the TUI (core/status.ts imports the same file) — served unbuilt.
  "/time-ago.js": "../../shared/time-ago.js",
  // Unified-patch parser, shared with its test suite — served unbuilt.
  "/diff-lines.js": "../../shared/diff-lines.js",
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
// /sessions — projection (drop the large lastCapture blob), served
// stale-while-revalidate (see sessionsPayload) so a request never blocks on the
// ps/tmux/git discovery sweep and SSE reconnect storms can't fan out into
// concurrent subprocess swarms.
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

function projectSession(
  s: Session,
  pending: ReturnType<typeof pendingToolCall>,
  approvalIds: Set<string>,
  unread: boolean,
  restorable?: RestoreState,
  pendingScriptCount?: number,
) {
  // Pending = blocked-on-USER, sourced from the hook log (not status): discovery can
  // mislabel a live blocked session as `archived`, but it must stay reachable from the
  // phone. ONLY a real question or a real awaiting-decision approval counts — an
  // in-flight auto-approved tool is NOT pending (that was the false bash-approval bug).
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
    // The age the phone renders: last conversational turn, falling back to the mtime in
    // `modified` when the transcript holds no timestamped turn.
    lastTurn: sessionActivityAt(s).toISOString(),
    // Present only for archived sessions: whether/where the phone can resume it
    // ("yes" | "relocated" | "no") — drives the restore bar's button and label.
    ...(restorable !== undefined ? { restorable } : {}),
    // ≥1 background script still awaited (live sessions only) — the list's ⏳ badge, so
    // a `ready` session mid-wait doesn't read as done from the list.
    ...(pendingScriptCount ? { pendingScripts: pendingScriptCount } : {}),
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
// plus the configured repoPaths, exactly as the TUI wizard sources them. Sources the
// session set from the discovery snapshot computeSessionsPayload already produced
// (repo membership changes on human timescales — no need for a dedicated sweep), and
// falls back to a real discovery only before the first projection exists.
async function reposPayload(): Promise<Array<{ name: string; path: string; branch: string; isWorktree: boolean }>> {
  const cfg = await loadConfig();
  const sessions = lastDiscovered ?? (await discoverSessions({})).sessions;
  const sessionRepos = sessions
    .filter((s) => s.repoPath)
    .map((s) => ({ name: s.repo, path: s.repoPath }));
  const repos = await discoverRepos(sessionRepos, cfg.repoPaths ?? [], cfg.priorityRepos ?? []);
  const priority = cfg.priorityRepos ?? [];
  // "~" (home dir) is offered as a launch target, sorted among the base repos the same
  // way discoverRepos orders them (insert before the first base repo it sorts ahead of,
  // so worktree rows stay nested under their base).
  const home = { name: "~", currentBranch: "", hasSession: false };
  let at = repos.findIndex((r) => !r.isWorktree && compareRepos(home, r, priority) < 0);
  if (at === -1) at = repos.length;
  const withHome = [...repos];
  withHome.splice(at, 0, { name: "~", path: homedir(), currentBranch: "" });
  return withHome.map((r) => ({
    name: r.name,
    path: r.path,
    branch: r.currentBranch,
    isWorktree: !!r.isWorktree,
  }));
}

let sessionsCache: { ts: number; value: unknown } | null = null;
// The full session set from the last completed discovery — reused by /repos so opening
// the wizard doesn't re-run the ps/tmux/git sweep the projection just paid for.
let lastDiscovered: Session[] | null = null;

// The wizard is the only consumer and a repo appearing/disappearing is a human-timescale
// event; 15s keeps a reopened wizard instant while an expired hit revalidates behind it.
const REPOS_TTL = 15_000;
const cachedRepos = swrCache(REPOS_TTL, () => reposPayload());

/**
 * Generic stale-while-revalidate cell (the /changes, /pr and /repos caches): a fresh
 * hit serves the value; an EXPIRED hit serves the stale value immediately and kicks one
 * deduplicated background recompute (a failed recompute keeps the stale value); only a
 * cold miss (nothing cached for the key) blocks the request, deduped across concurrent
 * callers. The phone therefore never waits on git/gh past a key's very first request.
 */
function swrCache<V>(ttl: number, compute: (key: string) => Promise<V>): (key: string) => Promise<V> {
  const cache = new Map<string, { ts: number; value: V }>();
  const inflight = new Map<string, Promise<V>>();
  const start = (key: string): Promise<V> => {
    let p = inflight.get(key);
    if (!p) {
      p = compute(key)
        .then((value) => {
          cache.set(key, { ts: Date.now(), value });
          return value;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  };
  return async (key: string): Promise<V> => {
    const hit = cache.get(key);
    if (!hit) return start(key); // cold miss — block, deduped
    if (Date.now() - hit.ts >= ttl) start(key).catch(() => {}); // expired — revalidate behind the response
    return hit.value;
  };
}

// The changed-files card and the full list are separate components rendering the same URL,
// and the list is an overlay — opening it doesn't unmount the card, so every transcript
// revision ran the whole git sweep twice. 1s freshness, matching /sessions: short enough
// that opening the list still reflects an out-of-band edit (you editing on the Mac, a
// formatter running), long enough to collapse the duplicate. `/diff` shares it to resolve
// renames (a slightly stale `orig` self-corrects on the next fetch).
const CHANGES_TTL = 1000;
const cachedBranchChanges = swrCache(CHANGES_TTL, (sessionId) => branchChanges(sessionId));

// The PR lookup shells out to `gh`, which hits the network — so unlike /changes (git only,
// 1s freshness) it gets a minute. A PR's state changes on human timescales; re-querying
// GitHub every time the changed-files list is opened would put a visible stall on a
// glance surface.
const PR_TTL = 60_000;
// Keyed by SESSION, with the root resolution inside the compute: repoRootForSession is
// itself a transcript+git walk, so keying by root would leave it on every warm request.
// `{ state: "none" }` (no live repo) caches like any other answer and revalidates the
// same way, so an idle session that comes back live self-corrects within the TTL.
const cachedSessionPr: (sessionId: string) => Promise<PullRequestInfo | { state: "none" }> = swrCache(
  PR_TTL,
  async (sessionId) => {
    const root = await repoRootForSession(sessionId);
    return root ? branchPullRequest(root) : { state: "none" };
  },
);

// GET /sessions/:id/skills — slash-commands scoped to the session's repo. Cached per
// resolved repo dir (30s TTL); the "" key holds the builtin+user fallback used when a
// session's pane/repo can't be resolved (archived / no live pane).
const skillsCache = new Map<string, { list: unknown; ts: number }>();

async function sessionSkills(sessionId: string): Promise<unknown> {
  let repoDir = "";
  try {
    const paneId = await resolveSessionPane(sessionId);
    if (paneId) {
      const pane = (await listPanes()).find((p) => p.paneId === paneId);
      if (pane?.currentPath) repoDir = await getBaseRepoPath(pane.currentPath);
    }
  } catch {}
  const hit = skillsCache.get(repoDir);
  if (hit && Date.now() - hit.ts < 30_000) return hit.list;
  const list = await listSlashCommands(repoDir || undefined);
  skillsCache.set(repoDir, { list, ts: Date.now() });
  return list;
}

/**
 * Serve /sessions stale-while-revalidate with BOUNDED staleness: a projection younger
 * than SESSIONS_FRESH_MS serves as-is; older kicks one deduped background recompute and
 * serves the stale copy — but only up to SESSIONS_MAX_STALE_MS. Past that (the phone
 * returning from a long background, where the "fresher data exists" broadcast may have
 * been missed on a dead socket), the request WAITS for the recompute: a resume must
 * paint the current world, not however-old the last connected moment was. Nothing
 * cached at all (first request / explicit `sessionsCache = null` invalidation) also
 * waits. A changed recompute broadcasts `session-changed` so live clients converge.
 */
const SESSIONS_FRESH_MS = 1000;
const SESSIONS_MAX_STALE_MS = 10_000;
let sessionsRefreshing: Promise<unknown> | null = null;

/** One deduped recompute; rejections propagate to awaiting callers (never resolves null). */
function startSessionsRefresh(): Promise<unknown> {
  if (!sessionsRefreshing) {
    const prev = sessionsCache ? JSON.stringify(sessionsCache.value) : null;
    sessionsRefreshing = computeSessionsPayload()
      .then((value) => {
        if (prev !== null && JSON.stringify(value) !== prev) broadcast({ type: "session-changed" });
        return value;
      })
      .finally(() => {
        sessionsRefreshing = null;
      });
  }
  return sessionsRefreshing;
}

async function sessionsPayload(): Promise<unknown> {
  if (!sessionsCache) return startSessionsRefresh();
  const age = Date.now() - sessionsCache.ts;
  if (age >= SESSIONS_MAX_STALE_MS) return startSessionsRefresh();
  if (age >= SESSIONS_FRESH_MS) startSessionsRefresh().catch(() => {}); // revalidate behind the response
  return sessionsCache.value;
}

// --- History: the windowless archive (browse + search) ------------------------
// Backed by the TUI's global-search engine (core/search.ts): every transcript Claude
// still retains, no 24h window. Browse (empty q) pages by recency via a `before`
// timestamp cursor; a query returns one relevance-ranked page (rank order isn't
// chronological, so no cursor). Entries are cached briefly — the corpus scan reads
// head+tail of every transcript (~1s cold) and a debounced search keystroke shouldn't
// re-pay it; archive/restore bust the cache so a just-archived session appears at once.
const HISTORY_PAGE = 50;
const HISTORY_TTL_MS = 15_000;
let historyCache: { ts: number; entries: SearchEntry[] } | null = null;

async function historyEntries(): Promise<SearchEntry[]> {
  if (historyCache && Date.now() - historyCache.ts < HISTORY_TTL_MS) return historyCache.entries;
  const nameCache = await loadNameCache();
  // isActive should mean "has a live pane to switch to" — discovery's archived entries
  // carry ids too and must not count.
  const live = (lastDiscovered ?? []).filter((s) => s.tmuxPane);
  const entries = await loadAllSessions(nameCache, live);
  historyCache = { ts: Date.now(), entries };
  return entries;
}

async function historyPayload(params: URLSearchParams): Promise<unknown> {
  const q = (params.get("q") || "").trim();
  const repo = (params.get("repo") || "").trim();
  const before = Number(params.get("before") || NaN);
  const entries = await historyEntries();

  // Rank/filter before the repo facet is applied, so the chips row can show which
  // repos the current query still matches (and their counts).
  const matched = q ? filterAndRankEntries(entries, q, Number.MAX_SAFE_INTEGER) : entries;
  const repoCounts = new Map<string, number>();
  for (const e of matched) repoCounts.set(e.repo, (repoCounts.get(e.repo) ?? 0) + 1);

  let rows = repo ? matched.filter((e) => e.repo === repo) : matched;
  if (!q && Number.isFinite(before)) rows = rows.filter((e) => e.modified.getTime() < before);
  rows = rows.slice(0, HISTORY_PAGE);

  const payload = await Promise.all(
    rows.map(async (e) => ({
      id: e.sessionId,
      repo: e.repo,
      branch: e.branch,
      name: e.name,
      summary: e.summary,
      firstPrompt: e.firstPrompt,
      lastAssistant: e.lastAssistant,
      modified: e.modified.toISOString(),
      isActive: e.isActive,
      ...(e.matchField && q ? { matchField: e.matchField } : {}),
      ...(e.matchSnippet && q ? { matchSnippet: e.matchSnippet } : {}),
      // Disk checks for the returned page only; live rows just open their session.
      ...(e.isActive ? {} : { restorable: await restoreState(e.sessionId, e.projectPath, e.baseRepoPath) }),
    })),
  );

  return {
    rows: payload,
    // Cursor only while browsing, and only when the page filled (more may exist).
    before: !q && rows.length === HISTORY_PAGE ? rows[rows.length - 1]!.modified.getTime() : null,
    repos: [...repoCounts.entries()].map(([r, count]) => ({ repo: r, count })),
  };
}

async function computeSessionsPayload(): Promise<unknown> {
  const now = Date.now();
  const nameCache = await loadNameCache();
  const { sessions } = await discoverSessions({ nameMap: nameCache.names, archivedTtlMs: 15_000 });
  lastDiscovered = sessions; // snapshot for /repos (see reposPayload)
  const approvalIds = new Set(listPendingApprovals().map((a) => a.sessionId));
  const unread = await unreadPanes();
  const tracked = sessions.filter((s) => s.id); // untracked panes (no id) are unaddressable
  // One event-log read per session per build: the waiting-session check below and
  // projectSession both need the pending tool call.
  const pendingById = new Map(tracked.map((s) => [s.id, pendingToolCall(s.id)]));
  // Attached sessions never get a pending-file (the PreToolUse hook exits neutral so the
  // instant desk prompt shows) — so a phone-approvable permission prompt must be sourced
  // from the live pane. For each WAITING session with no file-pending and no open question,
  // confirm a permission prompt is actually on-screen before flagging it `approval`.
  // Captures are independent per pane — run them concurrently.
  await Promise.all(
    tracked.map(async (s) => {
      if (s.status !== "waiting" || approvalIds.has(s.id) || !s.tmuxPane) return;
      const pt = pendingById.get(s.id);
      if (pt?.name === "AskUserQuestion" && pt.question) return;
      if (isPermissionPrompt(await capturePane(s.tmuxPane.paneId))) approvalIds.add(s.id);
    }),
  );
  // Apply the cached name (pinned wins over AI-generated), mirroring the TUI/tmux.
  for (const s of tracked) s.name = getSessionName(s.id, nameCache) || s.name;
  // Disambiguate same-repo name collisions with a -2/-3 suffix, matching the TUI/tmux.
  const dnMap = new Map<string, string>();
  const byRepo = new Map<string, Array<{ id: string; name: string }>>();
  for (const s of tracked) {
    const bucket = byRepo.get(s.repo);
    if (bucket) bucket.push({ id: s.id, name: s.name });
    else byRepo.set(s.repo, [{ id: s.id, name: s.name }]);
  }
  for (const items of byRepo.values()) {
    for (const [id, name] of disambiguateNames(items)) dnMap.set(id, name);
  }
  // Apply the suffixed name onto the projection so the phone's name-first row title
  // (listTitle = s.name || s.label) shows `-2`/`-3`, matching the TUI/tmux.
  for (const s of tracked) s.name = dnMap.get(s.id) ?? s.name;
  // Restore state for archived sessions only (disk checks) — computed in an async pass
  // before the sync `.map()`, mirroring the approvalIds loop above.
  const restorableMap = new Map<string, RestoreState>();
  await Promise.all(
    tracked
      .filter((s) => s.status === "archived")
      .map(async (s) => {
        restorableMap.set(s.id, await restoreState(s.id, s.repoPath, s.baseRepoPath));
      }),
  );
  // Pending-script counts for sessions with a live Claude process only: without one the
  // task runner is gone, no notification can ever arrive, and a stale "pending" would
  // badge a dead session forever. Cached by (size, mtime) in pendingScriptsAt, so an
  // unchanged transcript costs one stat here.
  const scriptCounts = new Map<string, number>();
  await Promise.all(
    tracked
      .filter((s) => s.status === "running" || s.status === "ready" || s.status === "waiting")
      .map(async (s) => {
        const path = await resolveTranscriptPath(s.id);
        if (!path) return;
        const n = (await pendingScriptsAt(path)).length;
        if (n > 0) scriptCounts.set(s.id, n);
      }),
  );
  const value = tracked.map((s) =>
    projectSession(
      s,
      pendingById.get(s.id) ?? null,
      approvalIds,
      !!(s.tmuxPane && unread.has(s.tmuxPane.paneId)),
      restorableMap.get(s.id),
      scriptCounts.get(s.id),
    ),
  );
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
        !cache.pinned[s.id] &&
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

// controller → deviceId of the client behind it (undefined for pre-deviceId clients);
// the heartbeat keeps each connected device's consumer marker fresh.
const clients = new Map<ReadableStreamDefaultController, string | undefined>();
const encoder = new TextEncoder();

// Liveness marker for the focus-aware question-intercept hook: its mtime is the only
// on-disk signal that a phone is actually connected (the `clients` set is in-memory).
// The hook holds an AskUserQuestion for 600s ONLY when this marker is fresh (≤40s old),
// so nobody's-phone-connected never causes a 600s stall. Never crash the bridge.
const BRIDGE_CONSUMER = `${PATHS.dir}/bridge-consumer`;
function touchMarker(path: string): void {
  try {
    closeSync(openSync(path, "w")); // create/truncate → bumps mtime to now
  } catch {
    /* marker is best-effort */
  }
}
function clearMarker(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

// Per-device liveness markers (consumers/<deviceId>) — the push-suppression signal.
// Additive to the aggregate BRIDGE_CONSUMER above, which the question-intercept
// hook reads and which must keep its exact semantics.
function touchDeviceConsumer(deviceId: string): void {
  try {
    mkdirSync(CONSUMERS_DIR, { recursive: true });
  } catch {
    /* marker is best-effort */
  }
  touchMarker(`${CONSUMERS_DIR}/${deviceId}`);
}
function clearDeviceConsumer(deviceId: string): void {
  clearMarker(`${CONSUMERS_DIR}/${deviceId}`);
}

/** The validated device identity a portkey client sends on every request. */
function deviceOf(req: Request): string | undefined {
  const d = req.headers.get("x-csm-device");
  return isValidDeviceId(d) ? d : undefined;
}

function pushAll(frame: Uint8Array): void {
  for (const c of clients.keys()) {
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

/**
 * After an interrupt, wait for Claude's native status to leave "running" (busy→idle
 * ~1.5s later) and broadcast so clients refetch the now-"ready" status. `nativeStatus`
 * has a ~1s cache TTL, so ~500ms polling is the practical resolution floor; ~3.5s of
 * budget covers the flip. Always broadcasts on exit (even at timeout) so a missed
 * native write doesn't strand the client on the stale "running". Fire-and-forget.
 */
function reconcileAfterInterrupt(id: string): void {
  void (async () => {
    for (let i = 0; i < 7; i++) {
      await Bun.sleep(500);
      const status = await nativeStatus(id);
      if (status && status !== "running") break;
    }
    sessionsCache = null; // drop the 1s projection cache so the refetch re-derives status
    broadcast({ type: "session-changed", id });
  })();
}

function streamResponse(deviceId?: string): Response {
  let self: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      clients.set(controller, deviceId);
      touchMarker(BRIDGE_CONSUMER); // a phone is now connected — mark it fresh
      if (deviceId) touchDeviceConsumer(deviceId); // this device is watching live
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      clients.delete(self);
      if (clients.size === 0) clearMarker(BRIDGE_CONSUMER); // last phone gone — go stale now
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
    const fixture = fixtureData(method, path, url.searchParams);
    if (fixture !== undefined) return json(fixture);
  }

  if (method === "GET" && path === "/sessions") return json(await sessionsPayload());
  if (method === "GET" && path === "/pending") return json(listPendingApprovals());
  // EventSource can't set headers, so the deviceId rides a query param here.
  if (method === "GET" && path === "/stream") {
    const d = url.searchParams.get("device");
    return streamResponse(isValidDeviceId(d) ? d : undefined);
  }

  // --- Web Push: per-device subscriptions (see core/web-push.ts) ---
  if (method === "GET" && path === "/push/vapid-key") {
    try {
      return json({ key: await getVapidPublicKey() });
    } catch {
      // Keypair generation/persist failed — refuse rather than hand out a key
      // that won't survive the process (the client retries on next launch).
      return json({ ok: false, reason: "vapid-unavailable" }, 500);
    }
  }
  if (method === "POST" && path === "/push/subscribe") {
    const body = (await req.json().catch(() => ({}))) as {
      deviceId?: unknown;
      subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    };
    const sub = body.subscription;
    if (
      !isValidDeviceId(body.deviceId) ||
      typeof sub?.endpoint !== "string" ||
      !sub.endpoint.startsWith("https://") ||
      typeof sub.keys?.p256dh !== "string" ||
      typeof sub.keys?.auth !== "string"
    ) {
      return json({ ok: false, reason: "bad-args" }, 400);
    }
    saveSubscription(body.deviceId, {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
    return json({ ok: true });
  }
  // Server-truth for the client's launch check — pushManager.getSubscription()
  // can't see a server-side prune (404/410/VAPID-mismatch), so the client asks.
  if (method === "GET" && path === "/push/subscribed") {
    const d = url.searchParams.get("device");
    return json({ subscribed: isValidDeviceId(d) && getSubscription(d) !== null });
  }
  // sendBeacon target fired on visibilitychange→hidden: the client closes its
  // EventSource FIRST (so no heartbeat re-touches the marker on a lingering
  // socket), then beacons. Body is text/plain (sendBeacon can't set headers).
  if (method === "POST" && path === "/push/goodbye") {
    const d = (await req.text().catch(() => "")).trim();
    if (isValidDeviceId(d)) clearDeviceConsumer(d);
    return json({ ok: true });
  }
  if (method === "GET" && path === "/repos") return json(await cachedRepos(""));
  if (method === "GET" && path === "/history") return json(await historyPayload(url.searchParams));

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
    // Real awaiting-decision approval (blocking hook), NOT the in-flight pendingTool —
    // so Allow/Deny only appears when a decision is genuinely required. Detached sessions
    // surface it via the pending-file; an ATTACHED session has no file, so confirm a
    // permission prompt is live on the pane and synthesize the same card shape from the
    // pending tool call (identical Allow/Deny UI; /decision drives the keys instead).
    const resolveApproval = (pt: ReturnType<typeof pendingToolCall>, pane: string | null, capture: string) => {
      const blocked = listPendingApprovals().find((a) => a.sessionId === id) ?? null;
      if (blocked || !pane || !pt) return blocked;
      if (pt.name === "AskUserQuestion" && pt.question) return null;
      if (!isPermissionPrompt(capture)) return null;
      return {
        sessionId: id,
        ts: 0,
        tool: pt.name,
        tool_use_id: pt.toolUseId,
        input: { command: pt.command, file_path: pt.filePath, description: pt.description },
      };
    };

    // Fast path: the client holds this exact file revision (`?rev=`), so skip rebuilding
    // and re-shipping the turns — the payload that scales with thread length. Everything
    // that can change WITHOUT the file changing still ships fresh: the pending
    // tool/question (hook events log), approval + statusline (pane scrape), and the
    // subagent list (separate per-agent files — an agent finishing doesn't bump the
    // session file). The client merges these over its held turns.
    const wantRev = url.searchParams.get("rev");
    if (wantRev) {
      const at = await transcriptRevAt(id);
      if (at && at.rev === wantRev) {
        const [pane, subagents] = await Promise.all([resolveSessionPane(id), listSubagents(at.path)]);
        const capture = pane ? await capturePane(pane) : "";
        const pt = pendingToolCall(id);
        const statusline = pane ? await readPaneStatusline(pane, capture) : {};
        return json({
          unchanged: true,
          rev: at.rev,
          ...pendingToolFields(pt),
          subagents, // always present here ([] clears) — the client overwrites its copy
          approval: resolveApproval(pt, pane, capture),
          ...statusline,
        });
      }
    }

    // Full response: the whole active branch (reconstructed leaf→root) — a rewind can
    // shrink the conversation, so an append-only delta would leak abandoned-branch turns.
    // Transcript read and pane resolution share no state — overlap them.
    const [tx, pane] = await Promise.all([getTranscript(id), resolveSessionPane(id)]);
    // One capture serves both the permission-prompt check and the statusline scrape below.
    const capture = pane ? await capturePane(pane) : "";
    const approval = resolveApproval(pendingToolCall(id), pane, capture);
    // The live statusline + permission mode, scraped from the pane (the only faithful
    // source for the user's custom statusline and the auto/plan mode).
    const statusline = pane ? await readPaneStatusline(pane, capture) : {};
    return json({ ...tx, approval, ...statusline });
  }

  // Drill into ONE subagent's full conversation. Anchored like `…/transcript$` so it isn't
  // shadowed; getSubagentTranscript validates the agentId (traversal guard) and 404s on a
  // bad id / missing file.
  const subagent = path.match(/^\/sessions\/([^/]+)\/subagents\/([^/]+)$/);
  if (method === "GET" && subagent) {
    const id = decodeURIComponent(subagent[1]!);
    const agentId = decodeURIComponent(subagent[2]!);
    const tx = await getSubagentTranscript(id, agentId);
    if (!tx) return json({ ok: false, reason: "not-found" }, 404);
    return json(tx);
  }

  const skills = path.match(/^\/sessions\/([^/]+)\/skills$/);
  if (method === "GET" && skills) {
    return json(await sessionSkills(decodeURIComponent(skills[1]!)));
  }

  // --- Repo-scoped read-only diff access (Portkey Layer 1) — containment-guarded to the
  // session's live repo root. 404 on no-live-repo (idle/archived) or an escaping path.
  // `relTo` re-derives the repo-relative path from the guard's validated abs (which may have
  // normalized `..`), so git only ever sees a path known to be inside the repo. ---
  const relTo = (root: string, abs: string) => relative(root, abs);

  // Files this branch changed vs its base branch (committed + uncommitted) — the changed-files
  // card + full list. Only changed files, never the whole repo.
  const changes = path.match(/^\/sessions\/([^/]+)\/changes$/);
  if (method === "GET" && changes) {
    const data = await cachedBranchChanges(decodeURIComponent(changes[1]!));
    if (!data) return json({ ok: false, reason: "no-repo" }, 404);
    return json(data);
  }

  // Single-file diff, branch vs its base (committed + uncommitted, + untracked). `path` =
  // repo-relative, sent by the Edit/Write chip or a changed-files row; git calls use
  // `-- <rel>` so a leading-dash path can't be read as a flag.
  const diff = path.match(/^\/sessions\/([^/]+)\/diff$/);
  if (method === "GET" && diff) {
    const rel = url.searchParams.get("path");
    if (!rel) return json({ ok: false, reason: "no-path" }, 400);
    const id = decodeURIComponent(diff[1]!);
    const root = await repoRootForSession(id);
    if (!root) return json({ ok: false, reason: "no-repo" }, 404);
    const abs = safeRepoPath(root, decodeURIComponent(rel));
    if (!abs) return json({ ok: false, reason: "not-found" }, 404);
    const relPath = relTo(root, abs);
    // `orig` (the old path of a rename) makes the diff show the true rename rather than a
    // whole-file add. Resolve it from the change list rather than trusting the caller to
    // supply it: a tool chip only knows the path it edited, so a chip and a changed-files
    // row would otherwise disagree about whether the same file is new. The list is cached,
    // so this costs nothing on the common path. An explicit `orig` param still wins.
    const origParam = url.searchParams.get("orig");
    const origAbs = origParam ? safeRepoPath(root, decodeURIComponent(origParam)) : null;
    let orig = origAbs ? relTo(root, origAbs) : undefined;
    if (!orig) orig = (await cachedBranchChanges(id))?.files.find((f) => f.path === relPath)?.orig;
    return json(await fileDiff(root, abs, relPath, orig));
  }

  // The GitHub PR for this session's branch — the changed-files list's exit to the real review
  // surface. `{ state: "none" }` whenever there's nothing to link (default branch, no GitHub
  // remote, no gh), and the UI renders nothing for it.
  const pr = path.match(/^\/sessions\/([^/]+)\/pr$/);
  if (method === "GET" && pr) {
    return json(await cachedSessionPr(decodeURIComponent(pr[1]!)));
  }

  const decision = path.match(/^\/sessions\/([^/]+)\/decision$/);
  if (method === "POST" && decision) {
    const body = (await req.json().catch(() => ({}))) as { decision?: unknown; reason?: unknown };
    if (body.decision !== "allow" && body.decision !== "deny") {
      return json({ ok: false, reason: "bad-decision" }, 400);
    }
    const reason = typeof body.reason === "string" ? body.reason : undefined;
    const id = decodeURIComponent(decision[1]!);
    // Detached (blocking-hook) approvals resolve via the decision file; an attached
    // session has no such file, so drive its on-screen prompt with pane keystrokes.
    const blocked = listPendingApprovals().find((a) => a.sessionId === id);
    if (blocked) {
      decideApproval(id, body.decision, { reason, toolUseId: blocked.tool_use_id });
      markPortkeySource(id, { deviceId: deviceOf(req) });
      return json({ ok: true });
    }
    const r = await decideAttachedApproval(id, body.decision);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req) });
    return sendResult(r);
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
    const id = decodeURIComponent(rewind[1]!);
    const r = await rewindSession(id, body.upCount, body.text, body.mode);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req), text: body.text }); // rewind re-sends text → attributes by text-match
    return sendResult(r);
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
      const r = await sendMessage(id, text, saved.paths);
      // Image-only (empty text) can't text-match; fall back to the turn's prompt_id anchor.
      if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req), text: text.trim() ? text : undefined });
      return sendResult(r);
    }
    const body = (await req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof body.text !== "string") return json({ ok: false, reason: "bad-text" }, 400);
    const r = await sendMessage(id, body.text);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req), text: body.text });
    return sendResult(r);
  }

  const answer = path.match(/^\/sessions\/([^/]+)\/answer$/);
  if (method === "POST" && answer) {
    const body = (await req.json().catch(() => ({}))) as { selections?: unknown; toolUseId?: unknown };
    const sels = body.selections;
    // Optional pin to the question the client rendered — a stale card must not answer
    // the question that replaced it. Older cached clients omit it; the gate is skipped.
    const toolUseId = typeof body.toolUseId === "string" ? body.toolUseId : undefined;
    // One entry per question: each is a number (single-select) or number[] (multi-select).
    const valid =
      Array.isArray(sels) &&
      sels.length > 0 &&
      sels.every(
        (s) => typeof s === "number" || (Array.isArray(s) && s.every((n) => typeof n === "number")),
      );
    if (!valid) return json({ ok: false, reason: "bad-selection" }, 400);
    const id = decodeURIComponent(answer[1]!);
    const r = await answerSessionQuestion(id, sels as (number | number[])[], toolUseId);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req) }); // no text ⇒ anchors the current turn's prompt_id
    return sendResult(r);
  }

  // "Chat about this": decline the open question so the agent yields and waits for the
  // user's next message (the composer takes over on the phone). Works held (decision
  // file) and un-held (drives the native picker's own chat row).
  const clarify = path.match(/^\/sessions\/([^/]+)\/clarify$/);
  if (method === "POST" && clarify) {
    const id = decodeURIComponent(clarify[1]!);
    const r = await clarifySessionQuestion(id);
    if (r.ok) markPortkeySource(id, { deviceId: deviceOf(req) }); // no text ⇒ anchors the current turn's prompt_id
    return sendResult(r);
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
    historyCache = null; // the just-archived session should surface in History at once
    broadcast({ type: "session-changed", id: decodeURIComponent(archive[1]!) });
    return sendResult(result);
  }

  // Restore (resume an archived session in a new tmux window; blocks until its prompt is
  // live so a send right after opening lands). repoPath comes from discovery, not the client.
  const restore = path.match(/^\/sessions\/([^/]+)\/restore$/);
  if (method === "POST" && restore) {
    const id = decodeURIComponent(restore[1]!);
    // Full discovery (NOT skipArchivedSummaries — that flag also skips the fallback JSONL
    // scan, dropping index-less sessions the phone DID list → spurious not-found).
    const { sessions } = await discoverSessions({});
    const s = sessions.find((x) => x.id === id);
    // Already live (the Mac resumed it between list-render and tap) — the client just opens it.
    if (s && s.status !== "archived") return json({ ok: true, sessionId: id });
    let repoPath = s?.repoPath;
    let basePath = s?.baseRepoPath;
    if (!s) {
      // Older than discovery's 24h archived sweep — a History row. Resolve its repo
      // paths from the same engine that listed it.
      const entry = (await historyEntries()).find((e) => e.sessionId === id);
      if (!entry) return json({ ok: false, reason: "not-found" }, 404);
      repoPath = entry.projectPath;
      basePath = entry.baseRepoPath;
    }
    // Relocate to the base repo if the session's worktree was deleted, so the resume lands
    // (and doesn't fail `restoreSession`'s isDirectory guard). Mirrors the TUI resume path.
    const effectivePath = await recoverWorktreeTranscript(id, repoPath!, basePath!);
    const result = await restoreSession(id, effectivePath);
    sessionsCache = null; // drop the 1s projection cache so the refetch re-derives the now-live status
    historyCache = null; // the row's isActive/restorable just changed
    broadcast({ type: "session-changed", id });
    return sendResult(result);
  }

  // Interrupt (send Escape to stop a running turn). Interrupt fires no Stop hook, so the
  // event-sourced status stays "running"; nativeStatus de-latches it to "ready" ~1.5s
  // later but emits no SSE. So on success we poll nativeStatus and broadcast once it
  // leaves "running", pushing the flip to the list + other clients. The poll runs
  // un-awaited (fire-and-forget) so the response returns immediately.
  const interrupt = path.match(/^\/sessions\/([^/]+)\/interrupt$/);
  if (method === "POST" && interrupt) {
    const id = decodeURIComponent(interrupt[1]!);
    const result = await interruptSession(id);
    if (result.ok) reconcileAfterInterrupt(id);
    return sendResult(result);
  }

  // Switch model or reasoning effort. Body carries EXACTLY ONE of `model`/`effort`, each
  // validated against the allowlist before anything reaches the pane. Response includes
  // Claude's verbatim confirmation `line` (states the applied value + scope).
  const config = path.match(/^\/sessions\/([^/]+)\/config$/);
  if (method === "POST" && config) {
    const id = decodeURIComponent(config[1]!);
    const body = (await req.json().catch(() => ({}))) as { model?: unknown; effort?: unknown };
    const hasModel = typeof body.model === "string";
    const hasEffort = typeof body.effort === "string";
    if (hasModel === hasEffort) return json({ ok: false, reason: "bad-args" }, 400); // need exactly one
    if (hasModel) {
      if (!isModelArg(body.model as string)) return json({ ok: false, reason: "bad-args" }, 400);
      return sendResult(await setSessionModelEffort(id, "model", body.model as string));
    }
    if (!isEffortArg(body.effort as string)) return json({ ok: false, reason: "bad-args" }, 400);
    return sendResult(await setSessionModelEffort(id, "effort", body.effort as string));
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

/** Returns the server so tests can bind port 0 and stop it; `csm bridge` ignores it. */
export function startBridge(): ReturnType<typeof Bun.serve> {
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
  setInterval(() => {
    if (clients.size > 0) touchMarker(BRIDGE_CONSUMER); // keep the marker fresh while a phone is live
    for (const deviceId of new Set(clients.values())) {
      if (deviceId) touchDeviceConsumer(deviceId);
    }
    pushAll(encoder.encode(":\n\n"));
  }, 15_000);

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

  const server = Bun.serve({
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
  console.error(`csm bridge listening on http://${host}:${server.port}${FIXTURES ? " (fixtures mode — canned data)" : ""}`);

  // Pre-warm the /sessions projection so the phone's first request after a bridge
  // (re)start hits the served-from-cache path instead of paying the discovery sweep.
  if (!FIXTURES) void computeSessionsPayload().catch(() => {});
  return server;
}
