import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { readSearchArtifacts, scoreSearchEntry, filterAndRankEntries, type SearchEntry } from "./search";

let dir: string;
let n = 0;

beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/csm-search-`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: object[]): string {
  const path = `${dir}/t${n++}.jsonl`;
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const turn = (type: "user" | "assistant", text: string, timestamp: string) => ({
  type,
  timestamp,
  message: { role: type, content: text },
});

// --- readSearchArtifacts ------------------------------------------------------

test("tail content of a large transcript is searchable", async () => {
  // Head + ~64KB of filler pushes the closing exchange past the head chunk, so it is
  // only reachable via the tail read — the case that motivated the tail corpus.
  const filler = Array.from({ length: 700 }, (_, i) =>
    turn("assistant", `filler block ${i} ${"x".repeat(80)}`, "2026-07-01T10:00:00.000Z"),
  );
  const path = transcript([
    turn("user", "please fix the login flow", "2026-07-01T09:00:00.000Z"),
    ...filler,
    turn("assistant", "done: the xylophone-widget bug is fixed", "2026-07-01T12:00:00.000Z"),
  ]);
  const a = await readSearchArtifacts(path);
  expect(a.corpus).toContain("xylophone-widget");
  expect(a.corpus).toContain("login flow"); // head still covered
});

test("small transcript: corpus holds the text once, not head+tail duplicated", async () => {
  const path = transcript([turn("user", "unique-phrase-here", "2026-07-01T09:00:00.000Z")]);
  const a = await readSearchArtifacts(path);
  expect(a.corpus!.split("unique-phrase-here").length - 1).toBe(1);
});

test("lastTurnAt is the newest conversational turn, not trailing bookkeeping", async () => {
  const path = transcript([
    turn("assistant", "wrapped up", "2026-07-01T12:34:56.000Z"),
    { type: "file-history-snapshot", messageId: "x" },
    { type: "last-prompt", prompt: "..." },
  ]);
  const a = await readSearchArtifacts(path);
  expect(a.lastTurnAt).toBe(Date.parse("2026-07-01T12:34:56.000Z"));
});

test("lastAssistant is the final assistant message, truncated for display", async () => {
  const long = "z".repeat(300);
  const path = transcript([
    turn("assistant", "earlier answer", "2026-07-01T10:00:00.000Z"),
    turn("user", "one more thing", "2026-07-01T10:01:00.000Z"),
    turn("assistant", long, "2026-07-01T10:02:00.000Z"),
  ]);
  const a = await readSearchArtifacts(path);
  expect(a.lastAssistant).toBe("z".repeat(200) + "...");
});

test("missing file yields empty artifacts", async () => {
  expect(await readSearchArtifacts(`${dir}/nope.jsonl`)).toEqual({});
});

// --- scoring / ranking --------------------------------------------------------

function mkEntry(over: Partial<SearchEntry>): SearchEntry {
  const base: SearchEntry = {
    sessionId: `s${n++}`,
    projectPath: "/tmp/x",
    fullPath: "/tmp/x.jsonl",
    baseRepoPath: "/tmp/x",
    repo: "",
    branch: "",
    summary: "",
    firstPrompt: "",
    name: "",
    modified: new Date(),
    messageCount: 1,
    searchText: "",
    isActive: false,
    isDeletedWorktree: false,
    ...over,
  };
  base.searchText = [base.summary, base.corpus || base.firstPrompt, base.name, base.branch, base.repo]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return base;
}

test("repo-name match is capped: content match in another session outranks it", () => {
  const repoOnly = mkEntry({ repo: "csm" });
  const contentHit = mkEntry({ repo: "throxy", summary: "refactor csm bridge auth" });
  const ranked = filterAndRankEntries([repoOnly, contentHit], "csm");
  expect(ranked[0]!.sessionId).toBe(contentHit.sessionId);
  expect(ranked).toHaveLength(2);
});

test("recency bonus discriminates across the retention horizon, zero past ~90 days", () => {
  const days = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
  const at60 = scoreSearchEntry(mkEntry({ summary: "fix resurrect", modified: days(60) }), ["resurrect"]);
  const at95 = scoreSearchEntry(mkEntry({ summary: "fix resurrect", modified: days(95) }), ["resurrect"]);
  expect(at60).toBeGreaterThan(at95);
  expect(at95).toBe(60); // contains-tier only — no bonus left past the horizon
});

test("all words must match somewhere (token AND)", () => {
  const e = mkEntry({ summary: "resurrect fix", branch: "cwd-poisoning" });
  expect(scoreSearchEntry(e, ["resurrect", "cwd"])).toBeGreaterThan(0);
  expect(scoreSearchEntry(e, ["resurrect", "zeppelin"])).toBe(0);
});

// --- provenance -----------------------------------------------------------------

test("summary match carries field + snippet around the hit", () => {
  const e = mkEntry({ summary: "a very long summary about the pickSavedCwd home poisoning bug and more" });
  const [hit] = filterAndRankEntries([e], "poisoning");
  expect(hit!.matchField).toBe("summary");
  expect(hit!.matchSnippet).toContain("poisoning");
});

test("repo-only match carries field but no snippet (repo is already on the row)", () => {
  const e = mkEntry({ repo: "csm" });
  const [hit] = filterAndRankEntries([e], "csm");
  expect(hit!.matchField).toBe("repo");
  expect(hit!.matchSnippet).toBeUndefined();
});

test("content-only match snippets from the original-case corpus", () => {
  const e = mkEntry({ corpus: "…and then we fixed the Xylophone bug in the tail…" });
  const [hit] = filterAndRankEntries([e], "xylophone");
  expect(hit!.matchField).toBe("content");
  expect(hit!.matchSnippet).toContain("Xylophone");
});

test("empty query returns recency order untouched", () => {
  const older = mkEntry({ summary: "old", modified: new Date("2026-01-01") });
  const newer = mkEntry({ summary: "new", modified: new Date("2026-07-01") });
  const ranked = filterAndRankEntries([newer, older], "");
  expect(ranked.map((e) => e.sessionId)).toEqual([newer.sessionId, older.sessionId]);
});
