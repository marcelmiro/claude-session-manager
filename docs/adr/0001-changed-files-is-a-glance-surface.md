# 1. Portkey's changed-files view is a glance surface, not a review surface

Date: 2026-07-20
Status: accepted

## Context

Portkey (the mobile bridge) shows a "Changed files" card at the end of a session thread, a
full file list, and a per-file diff. The obvious way to grow it is toward code review —
reading arbitrary files, line numbers, syntax highlighting, search, per-file "viewed" marks,
a diff shown before you approve an `Edit`.

That growth direction assumes the phone is where changes get reviewed. It isn't. The
operator runs Claude in auto-accept mode and approves tool calls by default, deliberately, so
the agent isn't blocked waiting on a human. The review gate is the GitHub pull request, read
later at a desk. On the phone the question is never "is this code correct?" — it's "is the
agent doing roughly the right thing, or should I redirect it?"

## Decision

The changed-files view is scoped to **situational awareness**. It optimises for being
correct and cheap to glance at, not for depth.

In scope: the file list, per-file status and LOC delta, the per-file patch, and an honest
statement of what the numbers are measured against.

Explicitly out:

- **A diff on the approval card.** The operator approves by default; a diff at that moment is
  friction at a point they have chosen not to think. (`old_string`/`new_string` are already
  on the device, so this stays cheap to revisit if the working model changes.)
- **Reading files the session didn't change** — `repoTree()` / `readRepoFile()` were in the
  original plan and cut during implementation. This ratifies that cut.
- **Line numbers, syntax highlighting, search, filtering, per-file viewed state, split view,
  word-level intra-line diff, comment threads.** All serve review depth.

Because a glance is exactly the mode where nobody double-checks, any surface that can show a
**wrong or empty picture with no signal that it is wrong** is a defect of the highest class
here — higher than any missing capability.

## Consequences

- Correctness and honesty work gets prioritised over capability work. Concretely: literal git
  pathspecs so a filename containing glob metacharacters can't render another file's patch;
  a hunk-aware patch parser so a deleted `-- ` line can't be eaten by a file-header pattern;
  a verified `origin/HEAD` so a dangling symref can't silently collapse the view; and fetch
  failures that hold the last known list instead of asserting "nothing changed".
- The phone will keep saying less than a real review tool. That is the intended trade.
- If the operator's working model changes — reviewing from the phone, or approving
  selectively — this decision should be revisited before any of the "out" list is built.

## See also

- [0002 — the changed-files baseline is the merge-base](0002-changed-files-baseline.md)
