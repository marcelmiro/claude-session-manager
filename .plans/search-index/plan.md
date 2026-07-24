# Implementation plan

## Inc 1 — Index module (S)

**Depends on:** none
**Unblocks:** 2
**Files:** `src/core/search-index.ts` (new — includes `message_rows`-directed delete-then-reinsert, see data-model.md query pattern 2), `src/core/search-index.test.ts` (new, synthetic fixtures only — no dependency on real personal transcripts), `src/core/config.ts` (add `search-index.db` to `PATHS`)
**Done when:** GIVEN a synthetic fixture transcript (built via the existing `transcript()`/`turn()` test-helper pattern, sized so a target phrase sits outside a 32KB head/tail window), WHEN `indexTranscript()` runs then `messages_fts` is queried with a quoted `MATCH` for that phrase, THEN the session's `session_id` is returned; AND WHEN `indexTranscript()` runs twice on an unchanged file, THEN `indexed_files.indexed_at_ms` is unchanged; AND WHEN it runs again after the fixture is modified, THEN the session's old `messages_fts`/`message_rows` rows are fully replaced, not accumulated (assert via row count).
**Risks:** `bun:sqlite` is a first-of-its-kind persistence dependency in this repo — no existing pattern to copy for error handling, keep it isolated to this module. FTS5 can't be indexed on non-`text` columns, so `message_rows` (a plain indexed table) exists specifically to keep per-session deletes cheap (data-model.md).

## Inc 2 — Backfill routine + CLI (S)

**Depends on:** 1
**Unblocks:** 3
**Files:** `src/core/search-index.ts` (add `backfill()`, `ensureIndexed()` with the `index_meta` compare-and-set claim), `src/cli.ts` (new `reindex` subcommand), `bin/csm.ts` (route it)
**Done when:** WHEN `bun run bin/csm.ts reindex` runs against the real `~/.claude/projects` tree, THEN it exits 0, logs progress at ~100-session intervals with a percentage, and a subsequent `SELECT COUNT(*) FROM indexed_files` matches the session count `loadAllSessions()` enumerates; AND WHEN run a second time concurrently in another process, THEN the second invocation polls (per data-model.md Migration plan step 3) rather than redoing the work or erroring.
**Risks:** Real backfill duration is unmeasured until this increment — record observed wall-clock time in the PR description; it directly informs Inc 3's accepted bridge-timeout risk below.

## Inc 3 — Blocking wire-in, TUI + bridge (M)

**Depends on:** 2
**Unblocks:** 4
**Files:** `src/index.ts` (`/` search handler, ~line 1152), `src/bridge/server.ts` (`historyEntries()`), `src/core/search-index.ts` (`ensureIndexed()` from Inc 2)
**Done when:** GIVEN a missing/stale/not-yet-backfilled index, WHEN the TUI's `/` search opens, THEN it shows a "Building search index…" status-bar message and blocks until `ensureIndexed()` resolves before rendering results; AND WHEN the bridge's `/history` is requested under the same condition, THEN the HTTP response is simply delayed until `ensureIndexed()` resolves — no interim progress payload, the phone's existing generic "loading history…" state is what's visible meanwhile.
**Risks:** Two long-lived processes racing to backfill resolve safely via `index_meta`'s compare-and-set claim + poll (data-model.md), not a long-held transaction. Bridge risk (accepted, not mitigated): an unmeasured-duration blocking HTTP response risks reading as hung, or hitting a client/proxy timeout (e.g. `tailscale serve`) — accepted for v1 per the user's explicit blocking-backfill choice (D3); revisit if Inc 2's measured duration is uncomfortably long.

## Inc 4 — Query-path cutover (M)

**Depends on:** 3
**Unblocks:** 5
**Files:** `src/core/search.ts` (`scoreEntryDetailed`'s AND-gate *and* content-tier fallback, `scoreSearchEntry`'s signature, `searchEntries`'s per-word FTS lookup + its `matchSnippet` call site, `loadAllSessions`'s per-session mtime-diffed re-index call) — see [inc-4-notes.md](inc-4-notes.md), this touches more than "the content tier" and the reason is non-obvious.
**Done when:** GIVEN a synthetic fixture transcript with a target phrase outside any head/tail window (same fixture family as Inc 1), WHEN `filterAndRankEntries(entries, "<phrase>")` runs, THEN that session appears in the results with `matchField: "content"` AND a non-empty `matchSnippet`; AND WHEN the query term contains a hyphen (e.g. a ticket-ID-shaped term), THEN the query does not throw; AND WHEN `loadAllSessions()` runs twice with no transcript changes, THEN no session's `indexed_files` row is rewritten.
**Risks:** see inc-4-notes.md — the AND-gate/content-tier split is the main correctness trap here; missing it leaves this plan's own motivating bug unfixed despite the index being correctly populated.

## Inc 5 — Remove dead corpus code (S)

**Depends on:** 4
**Unblocks:** none
**Files:** `src/core/search.ts` (remove `corpusFrom`, `CHUNK_SIZE`, `TAIL_SLACK`, `MAX_SEARCH_CONTENT`, and the corpus-building parts of `readSearchArtifactsInner` — **keep** the `lastTurnAt`/`lastAssistant` tail-read logic, unrelated display/recency plumbing), `src/core/search.test.ts` (remove obsolete corpus tests; keep `lastTurnAt`/`lastAssistant` tests)
**Done when:** WHEN `bun test` runs, THEN it's green with the corpus-building paths deleted and `lastTurnAt`/`lastAssistant` tests still passing; AND `grep -n "MAX_SEARCH_CONTENT\|corpusFrom\|entry\.corpus\|fullFirstPrompt" src/core/search.ts` returns no matches (confirms Inc 4 fully stopped depending on these before they're deleted).
**Risks:** Must not delete `lastTurnAt`/`lastAssistant` computation — call this out explicitly in the PR description. After this merges, reverting Inc 4 requires reverting this increment too (see data-model.md Rollback).
