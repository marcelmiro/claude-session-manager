# Persistent Full-Transcript Search Index

## What & why

`src/core/search.ts` currently searches session content via a capped head+tail
read of each transcript (32KB each side, ~6000 chars after two bugs fixed this
session). Content in the true middle of a long transcript is structurally
unreachable — confirmed on a real session (`eaf062f2-f6b4-4f4d-9e64-27846ddb6391`)
where a match sat 183KB into a 266KB file, outside both windows. This plan
replaces the content-tier's data source with a persistent SQLite FTS5 index
(via `bun:sqlite`, a Bun builtin — no new dependency) that indexes every
conversational message in every transcript, with no per-session cap. Named-field
scoring (summary/firstPrompt/name/branch/repo) is untouched; only how the
"content" tier finds matches changes. Backfill of existing history is eager and
blocking (user-confirmed): the first process to touch a fresh or stale index
builds it to completion before returning search results.

## Increment DAG

- Inc 1 — Index module (S) — depends on: none — unblocks: 2
- Inc 2 — Backfill routine + CLI (S) — depends on: 1 — unblocks: 3
- Inc 3 — Blocking wire-in, TUI + bridge (M) — depends on: 2 — unblocks: 4
- Inc 4 — Query-path cutover (M) — depends on: 3 — unblocks: 5
- Inc 5 — Remove dead corpus code (S) — depends on: 4 — unblocks: none

Linear chain — each increment's behavior is only meaningful once the prior one
exists (can't wire blocking backfill before backfill exists; can't cut the
query path over before the index is guaranteed populated; can't delete the old
code before nothing depends on it).

## Top 3 risks

- `scoreEntryDetailed` has two separate word-presence checks — a top-level
  AND-gate and a content-tier fallback — and both read `entry.searchText`,
  which loses transcript content entirely once Inc 5 deletes the code that
  populates it. Fixing only the fallback (the original scope) would leave the
  AND-gate silently rejecting every content-only match, so this plan's own
  motivating bug (Scenario 1) would still fail end-to-end. Caught in
  adversarial review, not initial design — see decisions.md D5 and
  [inc-4-notes.md](inc-4-notes.md). Mitigation: both checks move together in
  Inc 4, with a done-criterion that runs the actual reported query end-to-end.
- Blocking backfill can visibly pause search on first run for large
  histories. On the TUI this is a clean status-bar message; on the bridge/HTTP
  path there's no way to convey interim progress over a single blocking
  response, so a phone client only sees the existing generic loading state
  for an unmeasured duration — accepted for v1 per the user's explicit
  blocking-backfill choice (D3), revisit if Inc 2's measured duration is
  uncomfortably long relative to typical HTTP/proxy timeouts.
- Two long-lived processes (TUI, bridge) can race to backfill the same fresh
  index simultaneously. A naive `busy_timeout`-based lock can't reliably hold
  for an unmeasured, possibly-longer-than-the-timeout backfill — fixed via an
  explicit `index_meta` compare-and-set claim + poll loop instead (see
  data-model.md Migration plan), which is race-safe regardless of duration.

## Files

- [data-model.md](data-model.md) — SQLite/FTS5 schema & migration
- [plan.md](plan.md) — increment list
- [decisions.md](decisions.md) — architectural choices, sourced assumptions
- [verification.md](verification.md) — acceptance scenarios
- [inc-4-notes.md](inc-4-notes.md) — deep spec for Inc 4's non-obvious integration surface
