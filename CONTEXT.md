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

**Safeguard row**:
An archived-labeled row kept on the live sessions list because it is pending or unread — covers discovery transiently mislabeling a live blocked session as archived.

**Junk floor** (rejected):
A proposed filter hiding sessions with no assistant reply. Decided against: History shows everything except naming sessions and sidechains.
