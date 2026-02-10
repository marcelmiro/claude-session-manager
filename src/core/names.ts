import { homedir } from "os";

export interface NameCache {
  version: 1;
  names: Record<string, string>;
}

const CACHE_PATH = `${homedir()}/.config/csm/names.json`;

const STRIP_PREFIXES = [
  "implement the following plan", "implement the following",
  "implement this plan", "follow this plan",
  "i want you to", "i need you to", "i'd like you to",
  "can you", "could you", "please", "i want to", "i need to",
  "i'd like to", "let's", "help me", "go ahead and",
];

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "it", "its", "this", "that", "my", "me", "i", "and", "or",
  "but", "so", "if", "as", "do", "does", "did", "will", "would",
  "should", "could", "can", "have", "has", "had", "not", "no",
  "all", "some", "any", "each", "every", "into", "up", "out",
  "just", "also", "very", "really", "quite", "about", "here",
  "there", "then", "than", "now", "how", "what", "which",
  "implement", "following", "need", "want", "make", "look",
  "check", "investigate", "think", "consider", "ensure", "try",
  "using", "use", "like", "know", "get", "take", "give",
]);

// Lighter stop words for summaries (already concise — only filter articles/prepositions)
const SUMMARY_STOP_WORDS = new Set([
  "a", "an", "the", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "and", "or", "but", "is", "are", "was", "were",
]);

// Words that are too generic to form a useful name on their own
const GENERIC_NAME_WORDS = new Set([
  "implement", "plan", "task", "feature", "fix", "update", "change",
  "add", "create", "build", "new", "this", "that", "following",
  "do", "run", "execute", "complete", "follow", "make",
]);

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
 * Convert a curated summary to a kebab-case name.
 * Uses lighter stop word filtering since summaries are already concise.
 */
export function generateNameFromSummary(summary: string): string {
  if (!summary || summary.length > 100) return "";

  // Skip generic summaries
  const lower = summary.toLowerCase().trim();
  if (lower === "no prompt" || lower === "" || lower.startsWith("no ")) return "";

  // Remove punctuation and extra whitespace
  const text = summary.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

  // Split into words, filter light stop words, take first 4 meaningful words
  const words = text.split(" ")
    .filter((w) => w.length > 1 && !SUMMARY_STOP_WORDS.has(w))
    .slice(0, 4);

  if (words.length === 0) return "";

  // If every word is generic filler ("implement plan"), fall through to other signals
  if (words.every((w) => GENERIC_NAME_WORDS.has(w))) return "";

  return words.join("-");
}

/**
 * Programmatic name generation: strip prefixes, remove punctuation,
 * filter stop words, take first 2-3 meaningful words, kebab-case.
 */
export function generateNameFromPrompt(prompt: string): string {
  if (!prompt) return "";

  let text = prompt.toLowerCase().trim();

  // Strip role-playing/persona preambles: "as the company's CTO and chief product officer, ..."
  text = text.replace(/^as\s+[^,.]+[,.]\s*/, "");

  // Strip common conversational prefixes
  for (const prefix of STRIP_PREFIXES) {
    if (text.startsWith(prefix + " ")) {
      text = text.slice(prefix.length).trim();
    }
  }

  // Remove punctuation and extra whitespace
  text = text.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();

  // Split into words, filter stop words, take first 3 meaningful words
  const words = text.split(" ")
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    .slice(0, 3);

  if (words.length === 0) return "";

  return words.join("-");
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
    if (parsed.version === 1 && parsed.names) return parsed;
  } catch {
    // No cache or malformed
  }
  return { version: 1, names: {} };
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
 * Get session name using multi-signal priority chain:
 * 1. Cache (existing AI-generated name)
 * 2. summary (from sessions-index.json — concise, topic-focused)
 * 3. Plan title (extracted from "# Plan: Title" in firstPrompt)
 * 4. firstPrompt (current behavior, with better prefix/stop word handling)
 */
export function getSessionName(sessionId: string, firstPrompt: string, summary: string, cache: NameCache): string {
  if (cache.names[sessionId]) return cache.names[sessionId];

  // Use summary if it's a real summary (not just echoing firstPrompt)
  if (summary && summary !== firstPrompt) {
    const name = generateNameFromSummary(summary);
    if (name) return name;
  }

  // Try extracting a plan title from structured prompts
  const planTitle = extractPlanTitle(firstPrompt);
  if (planTitle) {
    const name = generateNameFromPrompt(planTitle);
    if (name) return name;
  }

  return generateNameFromPrompt(firstPrompt);
}
