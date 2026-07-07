import "../../test/helpers/home";
import { CSM_DIR } from "../../test/helpers/home";
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSessionName, loadNameCache, normalizeName, sanitizePinnedName, slugify, deslugify, looksLikeRefusal, type NameCache } from "./names";

const CACHE_FILE = join(CSM_DIR, "names.json");
function writeCache(obj: unknown) {
  mkdirSync(CSM_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(obj));
}

function cache(over: Partial<NameCache> = {}): NameCache {
  return { version: 5, names: {}, sources: {}, pinned: {}, ...over };
}

test("getSessionName: pinned name wins over AI name", () => {
  const c = cache({ names: { s1: "AI Name" }, pinned: { s1: "Pinned Name" } });
  expect(getSessionName("s1", c)).toBe("Pinned Name");
});

test("getSessionName: falls back to AI name when unpinned", () => {
  const c = cache({ names: { s1: "Fix Auth" } });
  expect(getSessionName("s1", c)).toBe("Fix Auth");
});

test("getSessionName: empty string when neither is set", () => {
  expect(getSessionName("s1", cache())).toBe("");
});

test("normalizeName: keeps casing and spaces, collapses whitespace", () => {
  expect(normalizeName("  Payments   Hotfix ")).toBe("Payments Hotfix");
  expect(normalizeName("Fix Auth Flow")).toBe("Fix Auth Flow");
});

test("normalizeName: strips window separators and control chars", () => {
  expect(normalizeName("Fix·Auth⚡+")).toBe("Fix Auth");
  expect(normalizeName("   ")).toBe("");
  expect(normalizeName("")).toBe("");
});

test("normalizeName: word-joining punctuation becomes a space (slugify splits, not merges)", () => {
  expect(normalizeName("Clarification—the first")).toBe("Clarification the first");
  expect(normalizeName("Fix/Auth Bug")).toBe("Fix Auth Bug");
  expect(normalizeName("Merge_Provider:Sync")).toBe("Merge Provider Sync");
  // hyphen is kept (kebab-friendly)
  expect(normalizeName("fix-auth")).toBe("fix-auth");
});

test("normalizeName: over-30 trims at a word boundary, never mid-word", () => {
  const out = normalizeName("This doesn't appear to be a source file");
  expect(out.length).toBeLessThanOrEqual(30);
  expect(out.endsWith(" ")).toBe(false);
  expect(out).toBe("This doesn't appear to be a"); // no dangling "so"
});

test("sanitizePinnedName: aliases normalizeName (keeps casing/spaces)", () => {
  expect(sanitizePinnedName("Payments Hotfix")).toBe("Payments Hotfix");
  expect(sanitizePinnedName("$$$")).toBe("$$$"); // symbols survive normalize; slugify strips later
});

test("slugify: lowercases, hyphenates, abbreviates via ABBREV", () => {
  expect(slugify("Fix Auth")).toBe("fix-auth");
  expect(slugify("Implementation Cleanup")).toBe("impl-cleanup");
  expect(slugify("Database Perf")).toBe("db-perf");
  expect(slugify("Fix Auth 2")).toBe("fix-auth-2");
  // domain-noun abbreviations that actually recur in real names
  expect(slugify("Delete Dead Organizations")).toBe("delete-dead-org");
  expect(slugify("Add Tomba Provider")).toBe("add-tomba-prov");
});

test("slugify: em-dash-joined words split into separate slug parts (not merged)", () => {
  expect(slugify(normalizeName("Clarification—the first"))).toBe("clarification-the-first");
});

test("looksLikeRefusal: rejects refusals/meta-replies, keeps real names", () => {
  expect(looksLikeRefusal("I can't help with this. I'm here to...")).toBe(true);
  expect(looksLikeRefusal("I need permission to read that")).toBe(true);
  expect(looksLikeRefusal("This doesn't appear to be a source file")).toBe(true);
  expect(looksLikeRefusal("I need clarification—the first thing")).toBe(true);
  expect(looksLikeRefusal("Fix Auth")).toBe(false);
  expect(looksLikeRefusal("Provider Sync")).toBe(false);
});

test("looksLikeRefusal: rejects self-introductions the namer emits for non-coding tasks", () => {
  // real garbage names observed in the wild
  expect(looksLikeRefusal("I'm Claude Code, designed for")).toBe(true);
  expect(looksLikeRefusal("I'm Claude Code, a")).toBe(true);
  expect(looksLikeRefusal("I'm a set up for")).toBe(true);
  expect(looksLikeRefusal("As an AI assistant I can")).toBe(true);
});

test("looksLikeRefusal: rejects rambles (comma or >4 words), keeps terse names", () => {
  expect(looksLikeRefusal("Fix, then refactor")).toBe(true); // comma
  expect(looksLikeRefusal("Update The Index And Types")).toBe(true); // 5 words
  expect(looksLikeRefusal("Delete Dead Organizations")).toBe(false); // 3 words, real
  expect(looksLikeRefusal("Add Tomba Provider")).toBe(false);
});

test("slugify: truncates to 24 chars with no trailing dash", () => {
  const out = slugify("Optimization Something Longer Words");
  expect(out.length).toBeLessThanOrEqual(24);
  expect(out.endsWith("-")).toBe(false);
});

test("slugify: strips symbols, empty stays empty", () => {
  expect(slugify("$$$")).toBe("");
  expect(slugify("")).toBe("");
});

test("deslugify: hyphens to spaces, Title-Case each word", () => {
  expect(deslugify("payments-hotfix")).toBe("Payments Hotfix");
  expect(deslugify("v2-api")).toBe("V2 Api");
});

test("loadNameCache: migrates v4→v5 discarding names, de-slugifying pinned", async () => {
  writeCache({ version: 4, names: { s1: "fix-auth" }, sources: { s1: "x" }, pinned: { s2: "payments-hotfix" } });
  const c = await loadNameCache();
  expect(c.version).toBe(5);
  expect(c.names).toEqual({});
  expect(c.sources).toEqual({});
  expect(c.pinned).toEqual({ s2: "Payments Hotfix" });
  rmSync(CACHE_FILE, { force: true });
});

test("loadNameCache: migrates v3 discarding names, empty pinned", async () => {
  writeCache({ version: 3, names: { s1: "fix-auth" }, sources: { s1: "fix the auth" } });
  const c = await loadNameCache();
  expect(c.version).toBe(5);
  expect(c.names).toEqual({});
  expect(c.pinned).toEqual({});
  rmSync(CACHE_FILE, { force: true });
});

test("loadNameCache: v1/v2 still discards names", async () => {
  writeCache({ version: 2, names: { s1: "old-name" }, sources: {} });
  const c = await loadNameCache();
  expect(c.version).toBe(5);
  expect(c.names).toEqual({});
  expect(c.pinned).toEqual({});
  rmSync(CACHE_FILE, { force: true });
});
