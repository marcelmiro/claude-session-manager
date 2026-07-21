# 4. The phone's model/effort switcher inherits Claude's own scoping

Date: 2026-07-20 (documenting an earlier decision)
Status: accepted

## Context

Portkey can change a session's model or reasoning effort: `/model` or `/effort` in the
composer opens a selection sheet, and tapping an option `POST`s to `/sessions/:id/config`.

Claude's own scoping for these commands is not uniform. Model and the normal effort levels
set the **global default** ("for new sessions"); `ultracode` applies to the **current session
only**. The bridge could have hidden that — by re-issuing the global default afterwards, or
by presenting everything as session-scoped.

## Decision

Don't paper over it. The bridge sends the arg-form slash command (`/model opus`,
`/effort ultracode`) through the existing send path and surfaces Claude's verbatim
confirmation toast. Scope is whatever Claude's scope is.

The route validates against `MODEL_ARGS` / `EFFORT_ARGS` (`core/session-api.ts`), so nothing
reaches the pane on a bad value.

## Consequences

- The phone never disagrees with the terminal about what a command did — the confirmation the
  user reads is Claude's own.
- The sheet has to label `ultracode` as session-only, because the user cannot infer it.
- Reading the *current* effort depends on the user's `~/.claude/statusline.sh` rendering
  `.effort.level` as *some* `•`-delimited segment (it replaced the older `• thinking`
  boolean); current *model* is already in the statusline. Position doesn't matter:
  `parseStatusline` (`core/session-api.ts`) splits on `•` and token-scans every segment for an
  `EFFORT_ARGS` member, last match winning, and for a model name — so a reordered statusline
  still resolves. Without that dotfile edit the switcher still works; the effort sheet just
  can't pre-mark the active level.
- The scrape is irreducible, not laziness: the native `~/.claude/sessions/<pid>.json` carries
  only `kind`, `sessionId`, `status`, `pid`, `updatedAt`. There is no structured per-session
  source for effort anywhere. Weighed against the alternatives in
  [ADR 6](0006-wrapping-claude-code.md).
- Mechanics are guarded by `test/smoke/model-effort.sh`, opt-in because it drives real
  sessions; it is not part of `bun test`.
