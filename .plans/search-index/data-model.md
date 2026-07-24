# Data model

New SQLite database: `~/.config/csm/search-index.db` (path added to the shared
`PATHS` const in `src/core/config.ts`, matching this repo's existing cache-path
convention).

## Entities & relationships

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- rows: ('schema_version', '1'), ('backfill_status', 'pending'|'running'|'done'),
--       ('backfill_started_at_ms', '<epoch ms as text>')

CREATE TABLE IF NOT EXISTS indexed_files (
  session_id      TEXT PRIMARY KEY,
  file_path       TEXT NOT NULL,
  file_mtime_ms   INTEGER NOT NULL,
  indexed_at_ms   INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  session_id UNINDEXED,
  seq        UNINDEXED,
  role       UNINDEXED,
  text,
  tokenize = 'unicode61'
);

-- FTS5 virtual tables can't carry a secondary index on an UNINDEXED column
-- (CREATE INDEX on one fails: "virtual tables may not be indexed" — verified
-- in review), so a session-scoped re-index would otherwise mean `DELETE FROM
-- messages_fts WHERE session_id = ?` doing a full scan of the whole content
-- store (verified via EXPLAIN QUERY PLAN: "SCAN messages_fts VIRTUAL TABLE").
-- This companion table turns that into an indexed rowid lookup.
CREATE TABLE IF NOT EXISTS message_rows (
  session_id TEXT NOT NULL,
  fts_rowid  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_rows_session ON message_rows(session_id);
```

`index_meta` (schema version + backfill coordination, see Migration plan),
`indexed_files` (one row per session, the freshness ledger), `messages_fts`
(one row per conversational message with non-empty text — no per-session or
per-message cap, unlike today's corpus mechanism), `message_rows` (session_id
→ FTS rowid, purely so re-indexing a session can delete its old rows cheaply).
All four relate by `session_id` as a soft reference (not a SQL foreign key —
FTS5 can't carry one), matching `SessionIndexEntry.sessionId` used throughout
`src/core/search.ts`.

## Constraints & indexes

- **Uniqueness:** `index_meta.key` and `indexed_files.session_id` are primary
  keys. `messages_fts`/`message_rows` have no uniqueness constraint by
  design — re-indexing a session deletes its old rows (via `message_rows`,
  see query pattern 2) before inserting fresh ones, so a session's content is
  fully replaced each time, never accumulated.
- **Foreign keys:** none anywhere (FTS5 can't carry them). `session_id` links
  are validated only by convention; see D2 in decisions.md for why an
  orphaned row is inert rather than a correctness bug.
- **NOT NULL:** all columns, by construction — the indexer never inserts a null.
- **Check constraints:** none needed (no numeric ranges to enforce).
- **Indexes:** FTS5 maintains its own internal index over `text`.
  `indexed_files.session_id` and `index_meta.key` are indexed via their
  `PRIMARY KEY`. `idx_message_rows_session` on `message_rows(session_id)` is
  what keeps per-session deletes cheap (the fix described above) — without
  it, re-indexing one actively-worked session would cost O(total rows in the
  whole index), growing worse as history accumulates.

## Query patterns

1. READ (freshness check, once per session per `loadAllSessions()` cycle):
   `SELECT file_mtime_ms FROM indexed_files WHERE session_id = ?` — compared
   against `Math.round(stat.mtimeMs)` (both sides rounded to avoid float
   round-trip precision mismatches producing spurious re-indexes); skip
   re-indexing when equal.
2. WRITE (index/re-index one session, in a transaction):
   ```sql
   DELETE FROM messages_fts WHERE rowid IN
     (SELECT fts_rowid FROM message_rows WHERE session_id = ?);
   DELETE FROM message_rows WHERE session_id = ?;
   -- for each conversational record with non-empty text, in order:
   INSERT INTO messages_fts (session_id, seq, role, text) VALUES (?, ?, ?, ?);
   INSERT INTO message_rows (session_id, fts_rowid) VALUES (?, last_insert_rowid());
   -- then:
   INSERT OR REPLACE INTO indexed_files
     (session_id, file_path, file_mtime_ms, indexed_at_ms) VALUES (?, ?, ?, ?);
   ```
3. READ (content-tier lookup, once per distinct query word per search — not
   once per session): `SELECT DISTINCT session_id FROM messages_fts WHERE
   messages_fts MATCH ?`, building a `Map<word, Set<sessionId>>` used in
   **two** places in `scoreEntryDetailed` — the top-level "all words must
   match somewhere" gate, and the per-word content-tier fallback (both
   currently read `entry.searchText`, which loses transcript content once
   Inc 5 removes the code that populates it; see
   [inc-4-notes.md](inc-4-notes.md) for why missing either one leaves the
   plan's own motivating bug unfixed).
4. READ (snippet, only for entries that rank onto the visible page — a
   handful per query): `SELECT text FROM messages_fts WHERE messages_fts
   MATCH ? AND session_id = ? ORDER BY rank LIMIT 1`, or FTS5's `snippet()`
   function — replaces `buildSnippet(entry.corpus, word)` at its actual call
   site inside `searchEntries()` (not inside `scoreEntryDetailed`).
5. WRITE (backfill/reindex CLI): loop over every session_id from the same
   enumeration `loadAllSessions()` already does (sessions-index.json glob +
   loose-jsonl fallback), calling pattern 2 per session, batched into outer
   transactions of ~100 sessions for write throughput.

**MATCH escaping (applies to every query above that binds a word):** FTS5's
query-string grammar treats bare hyphens, colons, and quotes as operators —
`MATCH` on a raw word like `eng-2687` throws `no such column: 2687` (verified
against `bun:sqlite`), and this codebase's own branch/ticket names are
routinely hyphenated. Every term is wrapped as an FTS5 phrase query in
application code before binding: `` `"${word.replace(/"/g, '""')}"` ``. Never
pass a raw word directly to `MATCH`.

## Sample rows

- `index_meta`: `{ key: "schema_version", value: "1" }`,
  `{ key: "backfill_status", value: "done" }`
- `indexed_files`: `{ session_id: "eaf062f2-f6b4-4f4d-9e64-27846ddb6391",
  file_path: "/Users/throxy/.claude/projects/-Users-throxy-Documents-leadflow/eaf062f2-f6b4-4f4d-9e64-27846ddb6391.jsonl",
  file_mtime_ms: 1753305600000, indexed_at_ms: 1753306000000 }`
- `messages_fts`: `{ session_id: "eaf062f2-f6b4-4f4d-9e64-27846ddb6391", seq: 107,
  role: "assistant", text: "Saved to ~/Downloads/call-quality-weekly.csv.
  Columns unchanged: week_start, week_end, ..." }`
- `message_rows`: `{ session_id: "eaf062f2-f6b4-4f4d-9e64-27846ddb6391", fts_rowid: 4821 }`

## Migration plan

1. On process startup, `openIndex()` connects to `search-index.db` (creating
   it if absent) and runs the DDL above with `CREATE TABLE IF NOT EXISTS` /
   `CREATE VIRTUAL TABLE IF NOT EXISTS` — idempotent, safe on every startup.
2. Read `index_meta.schema_version`. If missing or below the code's
   `SCHEMA_VERSION` constant: drop all four tables, recreate, set
   `schema_version` to current, set `backfill_status = 'pending'`.
3. `ensureIndexed()` (called by Inc 3's blocking wire-in) reads
   `backfill_status`:
   - `'done'` → return immediately (the common-case fast path after first run).
   - `'running'`, `backfill_started_at_ms` recent (< 10 min, a generous
     staleness bound) → poll: sleep 500ms, re-check, loop until `'done'`.
   - `'running'` but stale (crashed backfiller) → treat as `'pending'`.
   - `'pending'`/missing → attempt to claim it via a compare-and-set:
     `UPDATE index_meta SET value = 'running' WHERE key = 'backfill_status'
     AND value != 'running'`. If 1 row affected, this process won the claim —
     run backfill (query pattern 5), then set `backfill_status = 'done'`. If
     0 rows affected, another process claimed it first — fall into the
     polling branch above.
   - This compare-and-set is race-safe under SQLite's single-writer
     serialization and does **not** depend on `busy_timeout` blocking for the
     full (unmeasured, possibly >5s) backfill duration — the earlier draft's
     gap, caught in review: a single `busy_timeout`-based lock can't reliably
     hold for longer than the timeout itself.
4. Fully online — no offline migration window. A future schema bump means the
   next process to touch the index pays the (blocking, per D3) full rebuild
   cost once. Expected duration is dominated by whole-file transcript
   reads/parses across hundreds–low-thousands of files (today's existing
   corpus-supplement pass reads similar volume in "~1s cold" per its own code
   comment) plus SQLite inserts; must be measured against real data in Inc
   1/2's done-criteria, not assumed.

## Backwards-compatibility window

N/A — no dual-write or view shim needed. The existing head+tail corpus
mechanism keeps working untouched through Inc 1–4 (purely additive until Inc 4
flips the content-tier's data source); Inc 5 deletes it only once Inc 4 is
verified. Rollback before Inc 5 merges is a plain `git revert` of the relevant
increment's PR — no runtime feature flag, per this repo's convention of
changing code directly rather than adding toggles.

## Backfill

Required: yes (user-confirmed: eager, blocking). Batched: yes, ~100 sessions
per outer transaction, matching this repo's script convention of logging
progress every ~100–1k items with a percentage (scaled down here since totals
are in the hundreds–low-thousands, not millions). Idempotent: yes — the
delete-via-`message_rows`-then-reinsert pattern (query pattern 2) makes
re-running backfill, or two processes racing on the same fresh DB, safe and
convergent. Ordering: none required (per-session upserts are independent).
Coordination: the `index_meta` compare-and-set claim described in Migration
plan step 3 — not a long-held transaction or a `busy_timeout`-only lock — is
what makes concurrent backfill attempts (Scenario 4) safe. Duration:
unmeasured — Inc 2's done-criteria requires recording real wall-clock time
against the user's actual `~/.claude/projects` tree.

## Rollback

Inc 1–4 are additive; reverting any of them removes the new code path with
zero effect on existing corpus-based search. Reverting Inc 4 alone (before Inc
5 merges) restores corpus-based content scoring immediately — this is the
literal Scenario in verification.md that proves the cutover did something.
Reverting after Inc 5 has merged requires reverting Inc 5 alongside whichever
earlier increment is being undone, since Inc 5 deletes the fallback code
entirely — called out explicitly in Inc 5's plan.md block.
