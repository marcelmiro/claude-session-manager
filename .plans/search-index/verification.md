# Acceptance scenarios

## Scenario 1: Full-transcript recall (the reported bug)

GIVEN a synthetic fixture transcript (automated tests) with a target phrase
outside any head/tail window, or — for the manual PR-description check only —
the real session `eaf062f2-f6b4-4f4d-9e64-27846ddb6391.jsonl` and its
`week_start` mention
WHEN a user searches for that phrase via either the TUI's `/` or the bridge's
history search
THEN the matching session appears in the results with a non-empty
`matchSnippet` (not just a bare row with no "why this matched" context —
Inc 4's snippet call site must move together with the score lookup, per
inc-4-notes.md).

## Scenario 2: Fresh-install blocking backfill

GIVEN no `search-index.db` file exists yet
WHEN the TUI's `/` search is opened for the first time
THEN a "Building search index…" state is visible until backfill completes,
after which results render normally.

## Scenario 3: Incremental freshness after backfill

GIVEN backfill has completed and a session's transcript file is then appended
to (new turns added)
WHEN `loadAllSessions()` runs next
THEN only that session's `messages_fts` rows are rebuilt — every other
session's `indexed_files.file_mtime_ms` is unchanged.

## Scenario 4: Multi-process safety

GIVEN both the TUI and the bridge are running against the same fresh
(unindexed) history simultaneously
WHEN both independently trigger blocking backfill at nearly the same time
THEN neither process errors or corrupts the index, and the final
`indexed_files` row count matches the real session count exactly once backfill
settles.

## Scenario 5: Hyphenated query terms don't throw

GIVEN the index is populated
WHEN a user searches a hyphenated, ticket-ID-shaped term (e.g. `ENG-2687`,
the kind of term this codebase's own branch names routinely contain)
THEN the search returns a result set (possibly empty) rather than throwing a
SQLite exception — FTS5's query grammar treats bare hyphens as operators, so
every term must be wrapped as a phrase query before binding (data-model.md).

## Cross-cutting checks

- After Inc 1: `bun test src/core/search-index.test.ts` passes, including the
  synthetic-fixture target-phrase case (no dependency on real personal data).
- After Inc 2: `bun run bin/csm.ts reindex` against the real
  `~/.claude/projects` tree completes; record wall-clock duration in the PR
  description.
- After Inc 4: manually open the TUI, press `/`, search "week_start", and
  confirm `eaf062f2` appears — the literal bug this plan traces back to.
- After Inc 5: `bun test` and `bunx tsc --noEmit` are both clean with the old
  corpus code fully removed.
- Rollback: reverting Inc 4 alone (before Inc 5 merges) must restore
  corpus-based content scoring with zero changes elsewhere — verify by
  checking out the revert and re-running Scenario 1; it should now fail,
  confirming the revert actually removed the new behavior rather than adding
  a redundant path.
