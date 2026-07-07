import { homedir } from "os";

// Config root honors the CSM_HOME test seam (matches config.ts); unset in prod → real home.
const CSM_ROOT = process.env.CSM_HOME ?? homedir();

const NAMING_LOCK = `${CSM_ROOT}/.config/csm/naming.lock`;

/** Resolve the full path to `claude` CLI, searching common install locations beyond PATH. */
function resolveClaudePath(): string {
  const found = Bun.which("claude");
  if (found) return found;
  // tmux #() inherits a limited PATH — check common install locations
  const home = homedir();
  const candidates = [
    `${home}/.local/bin`,
    `${home}/.claude/bin`,
    "/usr/local/bin",
  ];
  for (const dir of candidates) {
    const path = Bun.which("claude", { PATH: dir });
    if (path) return path;
  }
  return "claude"; // fallback — will fail at spawn
}

const CLAUDE_PATH = resolveClaudePath();

export async function acquireNamingLock(): Promise<boolean> {
  try {
    const file = Bun.file(NAMING_LOCK);
    if (await file.exists()) {
      const { pid, ts } = JSON.parse(await file.text());
      if (Date.now() - ts < 60_000) {
        try { process.kill(pid, 0); return false; } catch {} // dead → stale
      }
    }
    await Bun.write(NAMING_LOCK, JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch { return false; }
}

export async function releaseNamingLock(): Promise<void> {
  try { const { unlink } = await import("fs/promises"); await unlink(NAMING_LOCK); } catch {}
}

export interface NameCache {
  version: 5;
  names: Record<string, string>;     // sessionId → AI-generated name (human-readable, e.g. "Fix Auth")
  sources: Record<string, string>;   // sessionId → summary/prompt used for naming
  pinned: Record<string, string>;    // sessionId → user-pinned name (wins over `names`)
}

/**
 * Deterministic abbreviation map applied ONLY by `slugify` (tmux width). Keys are
 * lowercase whole words; both long and short forms map to the compact form so an AI
 * name and a hand-typed one collapse the same way. Best-effort — words outside the
 * map pass through full, and `slugify`'s 24-char cap is the hard width backstop.
 */
export const ABBREV: Record<string, string> = {
  implement: "impl", implementation: "impl", impl: "impl",
  configuration: "cfg", config: "cfg", cfg: "cfg",
  authentication: "auth", auth: "auth",
  performance: "perf", perf: "perf",
  refactoring: "refactor", refactor: "refactor",
  database: "db", db: "db",
  // Domain nouns that actually recur in real session names and dominate tab width.
  organization: "org", organizations: "org",
  integration: "integ", integrations: "integ",
  visibility: "vis",
  notification: "notif", notifications: "notif",
  dashboard: "dash",
  migration: "migr", migrations: "migr",
  optimization: "opt", optimize: "opt",
  component: "cmp", components: "cmp",
  validation: "val", validate: "val",
  provider: "prov", providers: "prov",
  pipeline: "pipe", pipelines: "pipe",
  enrichment: "enrich",
  repository: "repo", repositories: "repo",
  permission: "perm", permissions: "perm",
};

/**
 * Conversational refusals/meta-replies the namer echoes when the source prompt is a
 * refusal or a vague follow-up ("I can't help…", "This doesn't appear…"). As a name
 * they read as broken UI, so we reject them and leave the window unnamed until a real
 * signal lands. Matched as case-insensitive prefixes of the raw model output.
 */
const REFUSAL_PREFIXES = [
  "i can't", "i cannot", "i can not", "i'm sorry", "i am sorry", "sorry",
  "i need permission", "i don't have", "i do not have", "i'm unable", "i am unable",
  "unable to", "this doesn't appear", "this does not appear", "i'd be happy",
  "i would be happy", "i need clarification", "i need more", "i'll need", "i cannot help",
  // First-person / conversational openers — a real name is a terse noun/verb phrase
  // ("Fix Auth"), never a sentence. Catches self-introductions the namer emits when
  // the source is a non-coding task ("I'm Claude Code, designed for…").
  "i'm", "i am", "i'll", "i'd", "i've", "as an", "as a", "let me", "here's",
  "here is", "sure", "certainly", "of course", "hello", "hey", "well,", "actually",
];

// Substrings that only appear when the model answered conversationally, not as a name.
const NOT_A_NAME_SUBSTRINGS = [
  "claude code", "as an ai", "language model", "ai assistant", "i'm claude", "i am claude",
];

/** True if the model output reads as a refusal/meta-reply rather than a session name. */
export function looksLikeRefusal(text: string): boolean {
  const lower = text.trim().toLowerCase();
  if (REFUSAL_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (NOT_A_NAME_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  // A name is 1-3 words with no sentence punctuation; a comma or >4 words is a ramble.
  if (lower.includes(",") || lower.split(/\s+/).filter(Boolean).length > 4) return true;
  return false;
}

/**
 * Normalize a name to the human-readable shape stored in the cache and shown on the
 * phone/TUI verbatim: trim, collapse internal whitespace to single spaces, strip
 * control chars and the window separators (`·`/`⚡`/`🔄`/`+`) that would corrupt the
 * tmux format even after slugify, but KEEP spaces and casing. Capped at 30 chars.
 */
export function normalizeName(input: string): string {
  const cleaned = input
    // Control chars, window separators (`·⚡🔄+`), and word-joining punctuation
    // (`/ \ : _ — –`) → space, so slugify splits on them instead of gluing words
    // ("clarification—the" → "clarification the", not "clarificationthe"). Hyphen
    // is intentionally kept (kebab-friendly).
    .replace(/[\x00-\x1f·⚡🔄+/\\:_—–]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 30) return cleaned;
  // Trim at a word boundary so the stored name never ends mid-word ("…to be a so").
  const cut = cleaned.slice(0, 30);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace >= 15 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Sanitize a user-typed pinned name — same rules as any stored name. */
export const sanitizePinnedName = normalizeName;

/**
 * Slugify a human-readable name to the kebab slug shown on tmux windows: lowercase,
 * abbreviate each word via `ABBREV`, join with `-`, strip remaining non-`[a-z0-9-]`,
 * collapse/trim dashes, and truncate to 24 chars (no trailing dash). Applied at every
 * window-name write; `reverseNameMap` keys on this so the round-trip resolves.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w) => ABBREV[w] ?? w)
    .join("-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
}

/** Inverse of `slugify` for migration: hyphens→spaces, Title-Case each word. */
export function deslugify(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const CACHE_PATH = `${CSM_ROOT}/.config/csm/names.json`;

/**
 * Extract a meaningful title from structured prompts like:
 * "Implement the following plan: # Plan: CSM UI Improvements ## Context..."
 * → "CSM UI Improvements"
 */
export function extractPlanTitle(prompt: string): string {
  if (!prompt) return "";

  // Find first # heading (not ## or deeper)
  const match = prompt.match(/(?:^|\n)# +(.+)/);
  if (!match) return "";

  let title = match[1].trim();

  // Skip meta headings
  const metaHeadings = ["phase executor prompt", "implementation plan generator"];
  if (metaHeadings.some((m) => title.toLowerCase().includes(m))) return "";

  // Strip category prefixes: "Plan: Title" → "Title"
  title = title.replace(/^(?:Plan|Fix|Feature|Refactor):\s*/i, "");

  // Strip trailing noise: "(4 Changes)", trailing "Plan"
  title = title.replace(/\s*\(\d+\s+\w+\)\s*$/, "");
  title = title.replace(/\s+Plan\s*$/i, "");

  return title.trim();
}

/**
 * AI-powered name generation using `claude -p`. Returns a normalized Title-Case name
 * or empty string on failure/refusal. `timeoutMs` bounds the subprocess — keep it low
 * (15s) for the background monitor so a hung `claude -p` can't stall its poll loop, but
 * the interactive TUI rename passes a longer budget so a cold haiku start resolves in
 * one attempt instead of being killed and leaving the window blank.
 */
export async function generateAIName(firstPrompt: string, summary?: string, branch?: string, lastPrompt?: string, timeoutMs = 15_000): Promise<string> {
  if (!firstPrompt && !summary && !lastPrompt) return "";

  try {
    const contextParts: string[] = [];
    // Always anchor on firstPrompt — it's the most reliable signal of intent.
    // Dropping it when summary/lastPrompt exist caused hallucinated names from
    // vague follow-ups like "IDK, go check that".
    const planTitle = extractPlanTitle(firstPrompt || "");
    if (planTitle) contextParts.push(`Plan title: "${planTitle}"`);
    if (firstPrompt) contextParts.push(`First message: "${firstPrompt.slice(0, 300)}"`);
    const usefulSummary = summary && summary !== firstPrompt ? summary : "";
    if (usefulSummary) contextParts.push(`Summary: "${usefulSummary}"`);
    if (lastPrompt && lastPrompt !== firstPrompt) {
      contextParts.push(`Most recent user message: "${lastPrompt.slice(0, 300)}"`);
    }
    if (branch) {
      // Strip ticket prefix (e.g. "ENG-2687-") for naming context
      const branchContext = branch.replace(/^[a-zA-Z]{2,6}-\d{2,}-?/, "");
      if (branchContext) contextParts.push(`Branch: "${branchContext}"`);
    }

    const namePrompt = `Name this coding session in Title Case, plain English words. Prefer 1-2 words; use 3 only when necessary (keep it short — it also labels a narrow tmux tab). Drop filler words (the, a, for, with, to). Focus on the ACTION and GOAL, not file paths or locations. Do NOT use kebab-case, do NOT abbreviate.

Good: Fix Auth, Dark Mode, Refactor API, Provider Sync
Bad: fix-auth, impl-dark-mode, packages-api-src, update-index-ts

Reply with ONLY the name, nothing else.

${contextParts.join("\n")}`;
    const proc = Bun.spawn([CLAUDE_PATH, "-p", "--model", "haiku", "--no-session-persistence"], {
      stdin: new Response(namePrompt),
      stdout: "pipe",
      stderr: "ignore",
      // CLAUDECODE=1 ensures cc_entrypoint=cli billing (Max subscription).
      env: { ...process.env, TMUX: "", TMUX_PANE: "", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" },
    });
    // Kill the subprocess after `timeoutMs` so a hung `claude -p` can't stall the
    // caller (the monitor's tmux #() runs one instance — a hang blocks all polls).
    const killTimer = setTimeout(() => proc.kill(), timeoutMs);
    const result = await new Response(proc.stdout).text();
    clearTimeout(killTimer);
    await proc.exited;
    if (proc.exitCode !== 0) return "";
    // Reject error/rate-limit messages that survive sanitization
    const lower = result.trim().toLowerCase();
    if (lower.includes("error") || lower.includes("credit") || lower.includes("balance") || lower.includes("rate limit") || lower.includes("unauthorized") || lower.includes("overloaded")) return "";
    // Reject conversational refusals/meta-replies echoed from a refusal source prompt.
    if (looksLikeRefusal(result)) return "";
    const name = normalizeName(result.trim());
    return name.length > 0 ? name : "";
  } catch {
    return "";
  }
}

export async function loadNameCache(): Promise<NameCache> {
  try {
    const raw = await Bun.file(CACHE_PATH).text();
    const parsed = JSON.parse(raw);
    if (parsed.version === 5 && parsed.names) return { pinned: {}, ...parsed };
    // Migrate v4→v5: discard kebab names+sources (regenerate as normalized on the
    // next monitor/bridge cycle) but de-slugify pins so the user's names survive.
    if (parsed.version === 4 && parsed.pinned) {
      const pinned: Record<string, string> = {};
      for (const [id, slug] of Object.entries(parsed.pinned as Record<string, string>)) {
        pinned[id] = deslugify(slug);
      }
      return { version: 5, names: {}, sources: {}, pinned };
    }
    // Migrate v3: discard kebab names/sources, no pins existed yet.
    if (parsed.version === 3 && parsed.names) {
      return { version: 5, names: {}, sources: {}, pinned: {} };
    }
    // Migrate from v1/v2: all empty.
    if ((parsed.version === 1 || parsed.version === 2) && parsed.names) {
      return { version: 5, names: {}, sources: {}, pinned: {} };
    }
  } catch {
    // No cache or malformed
  }
  return { version: 5, names: {}, sources: {}, pinned: {} };
}

export async function saveNameCache(cache: NameCache): Promise<void> {
  try {
    const dir = CACHE_PATH.replace(/\/[^/]+$/, "");
    await Bun.$`mkdir -p ${dir}`.quiet();
    await Bun.write(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // Non-fatal
  }
}

/**
 * Get session name from cache: user-pinned name wins over the AI-generated one.
 * Returns empty string if neither is set (window stays "claude" until naming completes).
 */
export function getSessionName(sessionId: string, cache: NameCache): string {
  return cache.pinned?.[sessionId] || cache.names[sessionId] || "";
}

