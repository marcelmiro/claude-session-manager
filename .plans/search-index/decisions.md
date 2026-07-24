# Decisions & assumptions

## D1: `bun:sqlite` + FTS5 as the persistence layer, not a hand-rolled JSON index

- **Context:** the existing content search relies on a capped head+tail text
  window (`src/core/search.ts`), which cannot structurally recall mid-transcript
  content — confirmed on a real session (`eaf062f2`) where a match sat at byte
  183K of a 266K file, unreachable by either window even after fixing two
  other bugs in the same code path this session.
- **Decision:** replace content-tier recall with a SQLite FTS5 virtual table
  via `bun:sqlite` (a Bun builtin — zero new `package.json` dependency),
  indexing every conversational message with no per-session cap.
- **Consequences:** first persistence mechanism in this codebase beyond flat
  JSON cache files; gains WAL-mode multi-process write safety and `PRAGMA
  user_version` schema versioning for free; loses the "everything is a JSON
  blob under `~/.config/csm/`" uniformity this repo has had until now.
- **Alternatives rejected:** a hand-rolled inverted index in a JSON/binary
  blob matching the existing `nameCache`/`script-wait.json` convention —
  rejected because it means reimplementing tokenization, incremental update,
  and full-text query semantics that FTS5 already provides, for a worse
  result.

## D2: Index is an auxiliary per-session lookup, not the source of truth for "which sessions exist" (user-confirmed)

- **Context:** today, `sessions-index.json` (via `loadAllSessions`'s glob) is
  the sole enumeration of which sessions exist; a second data store risks two
  systems disagreeing about existence.
- **Decision:** the SQLite index is consulted only as a per-`session_id`
  content lookup during scoring; `sessions-index.json` enumeration is
  untouched. No active pruning of index rows for deleted transcripts in v1 —
  orphaned rows are inert, since the session they reference is never
  enumerated in the first place.
- **Consequences:** the index can accumulate unbounded disk usage for
  deleted-session rows over time; acceptable for v1 — a maintenance sweep is
  a named follow-up, not blocking.
- **Alternatives rejected:** FTS-as-source-of-truth (query the FTS table
  directly for candidate session ids, actively pruning deleted rows) —
  rejected as a materially riskier second existence-tracking system for no
  benefit this plan's scope requires.

## D3: Backfill is eager and blocking (user-confirmed, overriding the recommended lazy/amortized default)

- **Context:** three backfill strategies were presented — lazy/amortized
  (recommended), eager blocking, eager background-with-fallback.
- **Decision:** eager, blocking — on a fresh or schema-stale index, the first
  process to touch it (TUI `/` search or bridge `/history`) runs backfill to
  completion before returning results.
- **Consequences:** first-run search pauses noticeably (duration unmeasured
  until Inc 2 — must be recorded); no corpus-fallback code path is needed
  during backfill, simplifying Inc 3/4 relative to the background-with-fallback
  alternative.
- **Alternatives rejected:** lazy/amortized — would avoid any blocking UX by
  piggybacking on `loadAllSessions`'s existing per-call cadence, at the cost of
  full recall only phasing in gradually. The user explicitly chose
  completeness-on-first-use over that gradualness.

## D4: Plain `unicode61` FTS5 tokenizer — no stemming or trigram typo tolerance (user-confirmed)

- **Context:** tokenizer choice trades scope/risk against recall quality;
  typo tolerance was a separately identified gap from the original
  search-improvement ideation in this conversation.
- **Decision:** ship with the default `unicode61` tokenizer; explicitly defer
  stemming/trigram tokenizers.
- **Consequences:** this plan solves exactly the reported bug (full-transcript
  recall) without also taking on tokenizer-tuning risk; typo tolerance remains
  unsolved and should be scoped as a separate follow-up plan if wanted.
- **Alternatives rejected:** trigram tokenizer (real typo tolerance, but a
  bigger, less-familiar FTS5 mode with different index-size/ranking behavior)
  — explicitly named out of scope by the user.

## D5: `scoreEntryDetailed`'s AND-gate and content-tier fallback both move to the index (found in review)

- **Context:** adversarial review caught that `entry.searchText` — read by
  both the top-of-function "all words must match somewhere" gate and the
  per-word content-tier fallback — only contains transcript content today
  because `fullFirstPrompt` is populated by the corpus-building code this
  plan deletes in Inc 5. Fixing only the content-tier fallback (the original
  Inc 4 scope) would have left the AND-gate rejecting content-only matches
  before the content tier ever ran — verification.md Scenario 1 would still
  fail after every increment landed.
- **Decision:** both the AND-gate and the content-tier fallback consult the
  same per-entry `Set<word>` of FTS-matched words, computed once per query via
  one FTS lookup per distinct word (not once per entry). Full mechanics in
  [inc-4-notes.md](inc-4-notes.md).
- **Consequences:** `scoreEntryDetailed`/`scoreSearchEntry` gain an optional
  third parameter; existing unit tests (which construct entries with `corpus`
  set directly, bypassing FTS) are unaffected since they don't pass it.
- **Alternatives rejected:** none — this is a correctness requirement surfaced
  by review, not a design choice with a real alternative.

## D6: Review-driven schema/coordination fixes

- **Context:** adversarial review, backed by empirical `bun:sqlite` testing,
  found three implementation-level gaps in the original draft: (1) `DELETE
  FROM messages_fts WHERE session_id = ?` is an unindexed full-table scan
  since FTS5 can't index `UNINDEXED` columns (verified via `EXPLAIN QUERY
  PLAN`); (2) raw query words passed to `MATCH` throw on ordinary hyphenated
  input like ticket IDs (verified empirically); (3) bumping a schema-version
  marker before backfill runs lets a racing second process conclude the index
  is ready when it isn't, and a `busy_timeout`-only lock can't reliably hold
  for an unmeasured, potentially-longer-than-the-timeout backfill.
- **Decision:** (1) add a `message_rows(session_id, fts_rowid)` table with an
  index on `session_id`, so per-session deletes are an indexed rowid lookup;
  (2) every term bound to `MATCH` is wrapped as an FTS5 phrase query in
  application code before binding; (3) backfill completion is tracked via an
  `index_meta` compare-and-set claim (`backfill_status: pending|running|done`
  with a poll loop), not a schema-version bump alone or a long-held
  transaction. Full DDL/mechanics in data-model.md.
- **Consequences:** schema grows by one small companion table
  (`message_rows`) and one key-value table (`index_meta`); coordination is a
  bounded poll loop (500ms interval) rather than a single blocking DB call.
- **Alternatives rejected:** FTS5 external-content-table mode (also solves
  the indexed-delete problem) — more moving parts than a plain companion
  table for this plan's scope.

## Assumptions resolved from code

- New cache path lives under the existing `PATHS` const in `config.ts` rather
  than a standalone root const (the pattern `names.ts` uses, flagged as the
  legacy outlier). Source: code @ `src/core/config.ts` (`PATHS`).
- Schema versioning uses `PRAGMA user_version` rather than an in-document
  `version` field (`names.ts`'s pattern) — SQLite's own PRAGMA is the natural
  equivalent for a SQL-backed store. Source: code @ `src/core/names.ts:47`
  (`NameCache.version`), applied by analogy to a SQL context.
- No custom file-locking/atomic-rename needed for the new store — SQLite's
  own WAL journal mode provides multi-process write safety, unlike this
  repo's existing plain-`Bun.write` JSON caches (which get away with
  last-writer-wins because they're small, infrequent, whole-document
  rewrites). Source: code @ `src/core/config.ts`, `src/core/names.ts`,
  `src/core/state.ts` (existing cache write patterns).
- `monitor` (`csm status`) is not wired to the index at all — it's a
  fresh-process-per-tick that already deliberately skips
  `loadAllSessions`/index-file scanning to stay fast under tmux's
  status-interval; nothing in this plan changes that. Source: code @
  `src/monitor.ts:59-63` (`quickDiscoverActive` comment).
- `lastTurnAt`/`lastAssistant` (display + recency-sort fields) stay computed
  from the existing lightweight tail read in `readSearchArtifactsInner` —
  Inc 5 removes only the corpus-building code, not this unrelated logic.
  Source: code @ `src/core/search.ts` (`readSearchArtifactsInner`).
- Named-field scoring tiers (summary/firstPrompt/name/branch/repo in
  `scoreEntryDetailed`) are unchanged by this plan; only the content-tier's
  data source moves from an in-memory corpus string to an indexed lookup.
  Source: user-confirmed (this conversation, prior turn).

## Open questions (from review)

- `file_mtime_ms` is written/compared as a JS float (`stat.mtimeMs`) against a
  SQLite INTEGER-affinity column; data-model.md now specifies rounding both
  sides (`Math.round`), but this is worth double-checking under implementation
  since a precision mismatch would either cause constant unnecessary
  re-indexing (false-negative freshness) or never re-index (false-positive) —
  neither fails loudly.
- D2's "no active pruning" acceptance should be revisited on a real threshold
  (e.g. sweep when orphaned-row count crosses some bound) rather than left
  fully unscheduled — now that `message_rows` exists, dead rows compound
  against its scan cost too, not just disk usage.
