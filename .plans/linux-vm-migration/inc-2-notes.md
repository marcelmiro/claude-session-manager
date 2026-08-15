# inc-2 notes — presence abstraction

## Lab-verify first (prototype gate)

Before wiring anything, confirm on a real Linux host (container with tmux is fine):

1. `tmux list-clients -F '#{client_activity}'` returns epoch seconds and **updates on keystrokes** (not just attach). Verify it does NOT update on pure output (a background `yes` filling a pane must not refresh it). **If output refreshes it, the concrete fallback is the Mac-side heartbeat agent from D1's rejected list** (launchd job POSTs "Ghostty frontmost" to a bridge endpoint → marker file, mirroring the bridge-consumer pattern) — surface to the user before building it; do not invent a third mechanism.
2. Behavior with 2+ attached clients (Mac Ghostty + a stray phone SSH): rule is **max** activity across clients.
3. `#{client_activity}` exists in the tmux version Ubuntu 24.04 ships (3.4) — it's ancient (tmux ≥1.6), but confirm the format string in both `list-clients` and `display-message -c` contexts used by monitor.ts.

## Polarity table (preserve exactly)

| Site | Today's probe | Fail/unknown maps to | Why |
|---|---|---|---|
| `monitor.ts` terminalFocused | osascript frontmost, catch → `true` | **present** | preserves auto-clear + push-suppression behavior on probe error |
| `atMacFocus` (hold release) | lsappinfo, catch → `false` | **absent** | never release a hold on ambiguity; only positive presence releases |
| question hook gate (bash) | lsappinfo, empty → don't intercept | **present** | never hold a session hostage when unsure |
| approval hook gate (bash) | attached-client non-empty → desk prompt | **present** (darwin: keep attached check verbatim) | a wrong "absent" strands every tool call in a 600s block-poll |

## Site-specific wiring

- **monitor.ts**: linux `terminalFocused` = presence fresh AND the probed client is the one whose active window we already read (the code already does `display-message -c ${client}`; add `#{client_activity}` to that same format string — one tmux call, no extra fork).
- **`clearSource` takeover** stays gated on `terminalFocused && activePaneId` — semantics unchanged, only the presence source differs.
- **bash sites**: inline snippet, `uname`-branched; linux form:
  `ACT=$(tmux list-clients -t "$SESS" -F '#{client_activity}' 2>/dev/null | sort -rn | head -1)`
  `[ -n "$ACT" ] && [ $(( $(date +%s) - ACT )) -le 60 ]`
  Darwin branch keeps the current lsappinfo/attached checks **verbatim** — zero behavior change at the desk today.
- **`PRESENCE_WINDOW`**: 60s in `core/presence.ts`; hook templates interpolate it at generation time (same pattern as `HOLD_WINDOW_MS`), so one constant feeds TS and bash.

## HOOK_VERSION rebase rule

inc-1 and inc-2 both bump `HOOK_VERSION` in `src/cli.ts`. inc-2 must be branched from (or rebased onto) inc-1's **merged** value before authoring its own bump — two branches independently minting the same version number would make installed hooks look current while missing one increment's template changes.

## Explicitly not doing

- No presence marker file (computed live; nothing to go stale).
- No Mac-side heartbeat agent (deferred follow-up — see decisions.md D2).
- No change to the bridge-consumer marker (phone liveness) — orthogonal to Mac presence.
