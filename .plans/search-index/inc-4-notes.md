# Inc 4 notes — query-path cutover

## Why this isn't a simple swap

`scoreEntryDetailed` (`src/core/search.ts`) has **two** places that check
whether a word is present for an entry, not one:

1. The top-of-function AND-gate: `for (const word of words) { if
   (!entry.searchText.includes(word)) return { score: 0, ... } }` — rejects
   the entry entirely before any tier scoring runs.
2. The per-word content-tier fallback inside the scoring loop: `if
   (wordScore === 0 && entry.searchText.includes(word)) { wordScore = 20;
   wordField = "content"; }`.

Both read `entry.searchText`, built from `entry.summary + (entry.fullFirstPrompt
|| entry.firstPrompt) + name + branch + repo`. `fullFirstPrompt` is populated
exclusively by the corpus-building code Inc 5 deletes. Fix only #2 and
`searchText` still never contains transcript content after Inc 5 — the AND-gate
silently rejects every content-only match before the content tier is ever
reached, even though the content tier itself is correctly wired to SQLite.
This is the exact bug this plan exists to fix (verification.md Scenario 1) —
get this wrong and Scenario 1 still fails end-to-end after Inc 4/5 land. (This
gap was caught in adversarial review of the original draft, not during initial
design — see decisions.md D5.)

## The fix

1. Before scoring runs, `searchEntries()` collects the distinct query words
   and issues one FTS query per word (data-model.md query pattern 3),
   building `Map<word, Set<sessionId>>`.
2. For each entry being scored, invert that into a small `Set<word>` — just
   the words that matched *this* entry's `sessionId` (at most `words.length`
   set lookups per entry, cheap).
3. `scoreEntryDetailed` gains one parameter: `scoreEntryDetailed(entry, words,
   contentHits: Set<string> = new Set())`. Both the AND-gate and the
   content-tier fallback check `entry.searchText.includes(word) ||
   contentHits.has(word)` instead of `searchText.includes(word)` alone.
4. `scoreSearchEntry` (the exported wrapper `search.test.ts` calls directly)
   gets the same optional third parameter, defaulting to an empty set —
   existing unit tests (which build entries with `corpus`/`searchText` set
   directly, bypassing FTS entirely) keep working unchanged.

## Other call sites that must move together

- `searchEntries()`'s snippet-building for `matchField === "content"`
  currently does `buildSnippet(entry.corpus, word!)`. `entry.corpus` is also
  populated only by code Inc 5 removes. Replace with an FTS5 snippet query
  (data-model.md query pattern 4) keyed by the entry's `sessionId` and
  whichever word won `bestWord`. Verify with a test asserting `matchSnippet`
  is non-empty for a match that lives outside any head/tail window — the row
  appearing in results isn't enough; a silently-empty "why this matched" line
  is a real, easy-to-miss regression.
- MATCH escaping (data-model.md): every word bound to `MATCH` — both pattern
  3's per-word queries and pattern 4's snippet query — must be wrapped as an
  FTS5 phrase query before binding, or a hyphenated term (ticket IDs like
  `ENG-2687`, common in this codebase's own branch names) throws.

## Test fixture

Do not depend on the user's live `~/.claude/projects` transcripts for `bun
test` — not portable, breaks in CI, breaks as the user's own history ages
out. Build a synthetic fixture using the existing `transcript()`/`turn()`
helpers in `src/core/search.test.ts` (or a fixture local to
`search-index.test.ts`): a large file with a target phrase positioned outside
a 32KB head/tail window, mirroring the real bug's shape without depending on
real personal data. The real `eaf062f2` session is for the manual
PR-description verification step only (verification.md cross-cutting checks).
