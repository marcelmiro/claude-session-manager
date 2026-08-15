# Data model

No database. CSM's persistence is flat files under `~/.config/csm/` plus Claude Code's own `~/.claude/`. This plan adds **no new persistent state** (presence is computed live from tmux) — the data-model work is (a) the inventory of what migrates to the VM vs regenerates, and (b) the presence read contract.

## 1. Entities & relationships

Existing files, by migration disposition:

| File / dir | Owner | Disposition on cutover |
|---|---|---|
| `config.json` | user | **copy** (repoPaths may need path edits: `~/Documents` holds repos on both) |
| `names.json` (v3) | AI naming | **copy** (cache keyed by session id — ids carry over) |
| `state.json` | monitor/TUI | **regenerate** (pane ids are host-local) |
| `panes/<paneId>`, `hook-events` | v7 hook | **regenerate** (pane ids host-local) |
| `resurrect-sessions.json` | save-sessions | **regenerate** (coordinates host-local) |
| `push-vapid.json` | web-push | **copy** (keypair valid at any origin) |
| `push-subscriptions.json` | web-push | **discard** — origin change invalidates every subscription; devices re-subscribe after PWA reinstall |
| `consumers/<deviceId>`, `source/<sessionId>.json`, `pushed/<deviceId>.json` | web-push | **regenerate** (transient markers) |
| `script-wait.json`, `verdicts/<taskId>` | script-wait | **regenerate** (keyed to local files/processes) |
| `pending/`, `decisions/`, `bridge-consumer` | hooks/bridge | **regenerate** (transient) |
| `~/.claude/projects/*` (transcripts, index) | Claude Code | **copy** (sessions resume by id on the VM); `~/.claude/settings.json` re-run `csm setup` instead of copying (hook paths identical but regenerate to pick up new HOOK_VERSION) |
| `~/.claude/.credentials.json` | Claude Code | **regenerate** via headless login on the VM (never copy credentials between hosts) |

## 2. Constraints & indexes (file-state invariants; no relational constraints apply)

The invariants that matter: atomic writes stay tmp→rename (`writeAtomic`), per-pane and per-task files stay one-file-per-key (concurrent writers: TUI + monitor + bridge).

## 3. Query patterns (presence read contract)

The new `core/presence.ts` computes, never stores:

1. `presence(): "present" | "absent" | "unknown"` — linux: `tmux list-clients -F '#{client_activity}'` → present iff max epoch ≥ now − 60s; darwin: today's frontmost probes. `unknown` on any probe error.
2. Monitor per-tick: presence + active-window match → auto-clear ⚡ / suppress active-pane transitions / `clearSource` takeover. Polarity: `unknown → present` (today's catch behavior).
3. Question-hold release (`atMacFocus`): presence + `window_active=1`. Polarity: `unknown → absent` (keep holding).
4. Hook scripts (bash, can't import TS): same read inlined — `tmux list-clients -t "$SESS" -F '#{client_activity}'` max vs now−60, branched on `uname` (darwin keeps lsappinfo). Polarity: `unknown → present` (don't intercept).
5. Approval-hook gate (`cli.ts` pretooluse): darwin keeps attached-client check; linux replaces it with the activity read (attached is the steady state on a VM, so it no longer implies presence).

## 4. Sample rows

N/A — no new files. Presence window constant: `PRESENCE_WINDOW_MS = 60_000`, one definition in `core/presence.ts`, mirrored as `PRESENCE_WINDOW_S=60` in generated hook scripts (HOOK_VERSION bump propagates it).

## 5. Migration plan

Ordered, from the runbook (inc-5): stop Mac monitor/bridge → `rsync` the **copy** rows above → `csm setup` on VM (regenerates hooks at new version) → headless `claude` + `gh` auth → start units → devices reinstall PWA at `https://<vm>.<tailnet>.ts.net` and re-grant push. No dual-write window: the Mac setup keeps working until the cutover hour; sessions resume on the VM by transcript id.

## 6. Backwards-compat window

During inc-1..4 (pre-cutover), all changes run on the Mac unchanged — darwin branches preserve today's behavior byte-for-byte. Post-cutover the Mac copy of `~/.config/csm` is left intact (rollback seed), not deleted.

## 7. Backfill

N/A — no derived state to rebuild; caches (`names.json` copied, verdicts regenerated) warm on first cycle.

## 8. Rollback

Cutover is reversible for ~days: Mac retains its `~/.config/csm` + repos + transcripts as of cutover. Rollback = stop VM units, restart Mac monitor/bridge, re-point PWA back (second reinstall), `rsync` back any VM-side transcript deltas for sessions worked on since. After the retention window, DLM-managed EBS snapshots of the VM are the rollback source.
