import { homedir } from "os";

const NAMING_LOCK = `${homedir()}/.config/csm/naming.lock`;

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
  version: 2;
  names: Record<string, string>;     // sessionId → name
  sources: Record<string, string>;   // sessionId → summary/prompt used for naming
}

const CACHE_PATH = `${homedir()}/.config/csm/names.json`;

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
 * AI-powered name generation using `claude -p`.
 * Returns kebab-case name or empty string on failure.
 */
export async function generateAIName(firstPrompt: string, summary?: string): Promise<string> {
  if (!firstPrompt && !summary) return "";

  try {
    const planTitle = extractPlanTitle(firstPrompt || "");
    const contextParts: string[] = [];
    if (summary) contextParts.push(`Summary: "${summary}"`);
    if (planTitle) contextParts.push(`Plan title: "${planTitle}"`);
    contextParts.push(`First message: "${(firstPrompt || "").slice(0, 300)}"`);

    const namePrompt = `Name this coding session in 2-4 words, kebab-case. Focus on the ACTION and GOAL, not file paths, code structure, or locations. The name should answer "what is being done?" not "where is it happening?".

Good: fix-auth-flow, add-dark-mode, refactor-api-client, improve-startup-perf
Bad: packages-api-src, src-utils-helpers, update-index-ts, components-modal

Reply with ONLY the kebab-case name, nothing else.

${contextParts.join("\n")}`;
    const proc = Bun.spawn(["claude", "-p", namePrompt], { stdout: "pipe", stderr: "ignore" });
    const result = await new Response(proc.stdout).text();
    const name = result.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
    return name.length > 0 && name.length <= 40 ? name : "";
  } catch {
    return "";
  }
}

export async function loadNameCache(): Promise<NameCache> {
  try {
    const raw = await Bun.file(CACHE_PATH).text();
    const parsed = JSON.parse(raw);
    if (parsed.version === 2 && parsed.names) return parsed;
    // Migrate from v1: carry over names, sources unknown
    if (parsed.version === 1 && parsed.names) {
      return { version: 2, names: parsed.names, sources: {} };
    }
  } catch {
    // No cache or malformed
  }
  return { version: 2, names: {}, sources: {} };
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
 * Get session name from cache. Returns empty string if not cached.
 * Window stays as-is (e.g. "claude") until AI naming completes.
 */
export function getSessionName(sessionId: string, cache: NameCache): string {
  return cache.names[sessionId] || "";
}

