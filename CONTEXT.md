# CSM

Terminal TUI + mobile bridge ("portkey") for managing Claude Code sessions. This glossary pins the canonical terms; `CLAUDE.md` covers architecture and `docs/adr/` covers decisions.

## Language

**Session**:
One Claude Code conversation, identified by its UUID, backed by a transcript JSONL on disk.

**Archived session**:
A session with no live Claude process; its transcript remains on disk and it can be restored.
_Avoid_: closed, dead, old session

**History**:
The archive surface: every archived session Claude still retains, browsable by recency and searchable. Not time-windowed.
_Avoid_: archived list, archive view

**Restore**:
Resuming an archived session in a new tmux window (`claude --resume`), waking it back to live.
_Avoid_: resume (reserved for Claude's own CLI flag), reopen

**Restore states**:
*Restorable* — the session's original directory exists; restores in place. *Relocated* — its worktree is gone but the base repo exists; restores in the base repo. *Non-restorable* — base repo or transcript is gone; readable but not restorable.

**Inbox**:
A view over sessions grouped by lifecycle state. An inbox item *is* a session (keyed by its UUID) — there is no free-standing work-item object, and no item without a transcript.
_Avoid_: work item, task, thread

**Disposition**:
The authored lifecycle state of a session in the Inbox: *snoozed* (carries an `until` date) or *blocked* (carries a free-text note). Absence of a disposition is the normal case. Orthogonal to activity status, which is always derived, never authored. Setting a disposition archives the pane: a live pane exists only for sessions actively working.
_Avoid_: done (not a state — archiving is the done verb, History is the done pile)

**Parked**:
The Inbox section holding snoozed and blocked sessions, always expanded (a collapse toggle existed in the prototype, was never used, and was removed). A snoozed session whose wake date arrives leaves Parked and resurfaces in Needs you, marked as returned-from-snooze.

**Needs you**:
The Inbox section for sessions awaiting a human response. Admission is transition-gated: an OBSERVED transition into ready/waiting, a snooze wake, a live approval prompt, or a turn that finished while unattended — a session merely found sitting at a prompt does not qualify (it files under Open). An item leaves only by reply/approve (observed as a derived status transition), snooze/blocked, or archive — never by focus, glance, or notification tap. No silent decay.

**Open**:
The neutral Inbox section for live sessions with nothing unhandled — visible, dim, not nagging. Being here is fine; Needs you is the inbox. All verbs still apply (parking an idle session is legitimate).
_Avoid_: idle (that's an activity status, not a section)

**Recently done**:
Derived-archived sessions from the last 24h, shown muted at the bottom of the Inbox. Purely derived — no authored state.

**Safeguard row**:
An archived-labeled row kept on the live sessions list because it is pending or unread — covers discovery transiently mislabeling a live blocked session as archived.

**Junk floor** (rejected):
A proposed filter hiding sessions with no assistant reply. Decided against: History shows everything except naming sessions and sidechains.
