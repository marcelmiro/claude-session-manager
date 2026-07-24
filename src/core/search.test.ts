import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { readSearchArtifacts, scoreSearchEntry, filterAndRankEntries, searchEntries, CHUNK_SIZE, type SearchEntry } from "./search";

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

// Non-conversational byte padding: parseConversationRecords drops anything whose
// `type` isn't "user"/"assistant", so this contributes exact, known-size bytes to
// the file with zero effect on corpusFrom's text budget — lets a test position byte
// offsets precisely without the padding itself competing for the corpus cap.
const pad = (n: number) => ({ type: "filler", blob: "x".repeat(Math.max(0, n)) });
const padOverhead = JSON.stringify(pad(0)).length + 1; // + newline

test("a line straddling the tail-window's byte boundary is not silently dropped", async () => {
  // Reproduces a real transcript (throxy/leadflow eaf062f2): the tail read is a raw
  // byte slice, not line-aligned, so a boundary landing mid-line used to fail
  // JSON.parse on the leading fragment and drop that whole record — even though most
  // of its bytes were inside the window. Position a target line so the read window's
  // start byte falls strictly inside it, with only padding (no target text) after.
  const target = "boundary-marker-phrase";
  const targetLine = turn("assistant", `the csv has a ${target} column`, "2026-07-01T12:00:00.000Z");
  const targetLen = JSON.stringify(targetLine).length + 1; // + newline

  // Trailing padding sized so the tail window's start lands ~halfway through
  // targetLine: solving tailStart = preSize + targetLen + after - CHUNK_SIZE for
  // `after`, constrained to (CHUNK_SIZE - targetLen, CHUNK_SIZE) puts the boundary
  // inside [0, targetLen).
  const after = CHUNK_SIZE - Math.ceil(targetLen / 2);

  // Head padding pushes targetLine's start past CHUNK_SIZE so it's unreachable via
  // the head read — isolating this to the tail path.
  const path = transcript([pad(CHUNK_SIZE + 4096), targetLine, pad(after - padOverhead)]);
  const a = await readSearchArtifacts(path);
  expect(a.corpus).toContain(target);
});

test("a match a few turns before a long final message stays in the tail corpus", async () => {
  // Same transcript (eaf062f2), a second failure mode: the tail's cap was only
  // 3000 chars, and corpusFrom stops (`break`) the moment the running total reaches
  // it — before ever looking at earlier records. The real session's last two
  // messages (2770 + 461 chars) alone exceeded that cap, so the match three turns
  // back never got evaluated, independent of any slicing. Mirror those proportions.
  const target = "week-start-column-marker";
  const path = transcript([
    pad(CHUNK_SIZE + 4096), // unreachable via head
    turn("assistant", `columns unchanged: ${target}, week_end`, "2026-07-01T11:00:00.000Z"),
    turn("assistant", "z".repeat(450), "2026-07-01T11:05:00.000Z"),
    turn("assistant", "y".repeat(2600), "2026-07-01T11:10:00.000Z"), // long wrap-up, no target text
  ]);
  const a = await readSearchArtifacts(path);
  expect(a.corpus).toContain(target);
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

// --- repo: scope + total ----------------------------------------------------

test("repo: token scopes to that repo; a bare word does not exclude other repos", () => {
  const inCsm = mkEntry({ repo: "csm", summary: "fix resurrect" });
  const elsewhere = mkEntry({ repo: "throxy", summary: "resurrect the csm bridge" });
  const scoped = searchEntries([inCsm, elsewhere], "repo:csm resurrect");
  expect(scoped.results.map((e) => e.sessionId)).toEqual([inCsm.sessionId]);
  // Same words without the token: both repos stay in play.
  const unscoped = searchEntries([inCsm, elsewhere], "csm resurrect");
  expect(unscoped.results).toHaveLength(2);
});

test("repo: matches by prefix and a bare scope browses that repo in given order", () => {
  // Entries arrive pre-sorted by recency from loadAllSessions; a word-less scope
  // must keep that order, only filtered.
  const newer = mkEntry({ repo: "csm", modified: new Date("2026-07-01") });
  const other = mkEntry({ repo: "throxy" });
  const older = mkEntry({ repo: "csm", modified: new Date("2026-01-01") });
  const { results, total } = searchEntries([newer, other, older], "repo:cs");
  expect(results.map((e) => e.sessionId)).toEqual([newer.sessionId, older.sessionId]);
  expect(total).toBe(2);
});

test("total reports all matches even when the page is capped", () => {
  const many = Array.from({ length: 7 }, () => mkEntry({ summary: "resurrect fix" }));
  const { results, total } = searchEntries(many, "resurrect", 3);
  expect(results).toHaveLength(3);
  expect(total).toBe(7);
});

test("empty query returns recency order untouched", () => {
  const older = mkEntry({ summary: "old", modified: new Date("2026-01-01") });
  const newer = mkEntry({ summary: "new", modified: new Date("2026-07-01") });
  const ranked = filterAndRankEntries([newer, older], "");
  expect(ranked.map((e) => e.sessionId)).toEqual([newer.sessionId, older.sessionId]);
});
