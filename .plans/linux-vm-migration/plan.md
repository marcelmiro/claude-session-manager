# Plan — linux-vm-migration

Increments are single PRs passing CI (`bun test`) independently. inc-1..4 develop and verify on the Mac; inc-5/6 execute on the VM.

## inc-1 — portability-fixes (S)

- Deps: none. Unblocks: inc-2, inc-5.
- Files: `src/core/runner-verdicts.ts`, `src/cli.ts` (hook script templates), `src/core/process.ts`, `src/core/tmux.ts` + `src/index.ts` (zsh hardcode), `scripts/shoot.ts`.
- Changes: `lsof` via `Bun.which("lsof")` with `/usr/sbin/lsof`,`/usr/bin/lsof` fallbacks (resolved once); hook `stat` → `stat -c %Y … || stat -f %m … || echo 0`; `ps` no-tty sentinel accepts `?` and `??`; window launches use `process.env.SHELL` basename (fallback `zsh`); `csm setup` registers hook commands as `bash <path>` (dash-proof); shoot.ts adds `google-chrome`/`chromium` candidates. HOOK_VERSION bump.
- Done: `bun test` green; new unit tests cover stat-chain and lsof resolution; `rg '/usr/sbin/lsof|stat -f %m' src/` shows only the fallback forms.

**Status:** done
**Attempts:** 1
**Files changed:** src/core/runner-verdicts.ts, src/core/process.ts, src/core/tmux.ts, src/index.ts, src/cli.ts, scripts/shoot.ts (matches plan) | extra: src/core/launch-command.ts (USER_SHELL constant home), src/cli.test.ts + src/core/runner-verdicts.test.ts (tests)
**Done-criteria check:** passed (evidence: /tmp/hawk-implement-plan-verify-inc1.log; 613 pass, no new tsc errors)
**Tests added/modified:** cli.test.ts (bash-command form, bare-path upgrade, stat chain, version 14), runner-verdicts.test.ts (LSOF resolution)

## inc-2 — presence-abstraction (M)

- Deps: inc-1 (hook templates). Unblocks: inc-5.
- Files: new `src/core/presence.ts`; `src/monitor.ts` (~187–191, 288–308), `src/core/tmux.ts` (`atMacFocus`), `src/cli.ts` (question hook + approval-gate templates), tests; new `docs/adr/0014-presence-is-client-activity.md` (D1 + D2: linux presence model, polarity table, tier-3 darwin-only, rejected heartbeat agent) + CLAUDE.md attention/notifications sections updated to reference it.
- Changes: tri-state `presence()` per `data-model.md §3`; darwin = existing frontmost probes (behavior unchanged), linux = client-activity ≤60s; each call site maps `unknown` per its documented polarity; bash sites get a `uname`-branched inline read. HOOK_VERSION bump (rebase on inc-1's merged value — see notes).
- Notes: `inc-2-notes.md` (lab-verify `client_activity` first, polarity table, multi-client rule, HOOK_VERSION rebase rule).
- Done: unit tests for the linux read (mocked tmux output) + polarity mapping; existing darwin tests unchanged; lab check on any Linux host/container: `tmux list-clients -F '#{client_activity}'` updates on keystroke and `presence()` flips within 60s.

**Status:** done
**Attempts:** 1
**Files changed:** src/core/presence.ts (+test), src/monitor.ts, src/core/tmux.ts, src/cli.ts (+test), docs/adr/0014, CLAUDE.md (matches plan) | extra: src/core/notifications.ts (tier-3 darwin gate — D2, documented in ADR 14)
**Done-criteria check:** passed (evidence: /tmp/hawk-implement-plan-verify-inc2.log; lab gate: Ubuntu 24.04/tmux 3.4 — output delta 0, keystroke refreshes; 619 pass)
**Tests added/modified:** presence.test.ts (5 classify cases), cli.test.ts (uname-branch gates, version 15)

## inc-3 — osc52-clipboard (S)

- Deps: none. Unblocks: inc-5.
- Files: `src/index.ts` (~214), new helper in `src/core/` (e.g. `clipboard.ts`), tests.
- Changes: `copyToClipboard(text)` — darwin: pbcopy (unchanged); else OSC 52 base64 to `/dev/tty`, tmux DCS-wrapped when `$TMUX`, doubled interior ESC, `ESC \` terminator; no-op above ~90KB with a status flash (tmux buffer cap).
- Done: unit test asserts exact escape framing (both wrapped/unwrapped); manual, self-contained: on any remote tmux run `tmux set -g set-clipboard on; tmux set -g allow-passthrough on` inline, then `Space→c` over SSH from Ghostty lands in the Mac clipboard (the deploy/ snippet in inc-4 persists these options; not a dependency of this check).

**Status:** done
**Attempts:** 1
**Files changed:** src/core/clipboard.ts (+test), src/index.ts (matches plan)
**Done-criteria check:** passed for framing (evidence: /tmp/hawk-implement-plan-verify-inc3.log); manual over-SSH check deferred to verification.md scenario 9 — the OSC path only executes off-darwin, so it needs the VM
**Tests added/modified:** clipboard.test.ts (bare/DCS framing, UTF-8 byte budget, size refusal boundary)

## inc-4 — deploy-provisioning (M)

- Deps: none. Unblocks: inc-5, inc-6.
- Files: new `deploy/`: `provision.sh`, `units/tmux.service`, `units/csm-bridge.service`, `tmux-vm.conf` snippet, `README.md`.
- Changes: idempotent provision.sh (creates/verifies the user with home **`/Users/throxy`** per D10 — transcript-path parity; apt: tmux zsh lsof git gh bubblewrap socat earlyoom; sysctl inotify `max_user_watches=1048576`/`max_user_instances=16384`; swapfile; `TZ`; journald `SystemMaxUse=500M`; needrestart `$nrconf{restart}='l'`; AppArmor bubblewrap profile; `loginctl enable-linger`); tmux unit (`WantedBy=default.target`, `ExecStop` → `csm save-sessions` then kill-server); bridge unit (`Restart=always`, `RestartSec=5s`, `StartLimitIntervalSec=300`, 0600 `EnvironmentFile` for `CSM_BRIDGE_TOKEN`); tailscale join (tagged authkey) + `tailscale serve --bg 8473`; tmux snippet: `escape-time 10`, `window-size largest`, `set-clipboard on`, `allow-passthrough on`.
- Done: `shellcheck deploy/provision.sh` clean; runs twice on a fresh Ubuntu 24.04 VM with identical end state; `getent passwd throxy` shows home `/Users/throxy` and `loginctl enable-linger` + user units work under it; `systemctl --user status` shows both units active after a reboot.

**Status:** done
**Attempts:** 2 (first container run caught a missing exec bit and that `useradd -m` won't create the `/Users` parent — both fixed, second run clean)
**Files changed:** deploy/provision.sh, deploy/units/{tmux,csm-bridge}.service, deploy/tmux-vm.conf, deploy/README.md (matches plan)
**Done-criteria check:** passed for container-verifiable scope (evidence: /tmp/hawk-implement-plan-verify-inc4.log — shellcheck exit 0; Ubuntu 24.04 double-run: RUN 2 all already/skip). systemd/linger/tailscale/reboot steps self-skip in containers → verification scenario 4 on the real VM
**Tests added/modified:** none (shell + unit files; validated by shellcheck + container double-run)

## inc-5 — cutover-runbook (M)

- Deps: inc-1, inc-2, inc-3, inc-4. Unblocks: inc-6.
- Files: `deploy/RUNBOOK.md` (+ any state-copy helper it needs); new `docs/adr/0015-vm-home-is-users-throxy.md` (D10: transcript-encoding parity, PAM/tooling caveats, rename-pass fallback) and `docs/adr/0016-systemd-units-replace-launchd.md` (D8 + D9: unit model, resurrect-never-spawns-claude); CLAUDE.md bridge-restart + resurrect sections rewritten to match.
- Changes: ordered runbook per `data-model.md §5`, prefaced by the D6 AWS launch checklist (r7i.2xlarge eu-central-1, IMDSv2 required, `nvme_core.io_timeout`, UUID+`nofail` mounts, EBS-only, budget guardrail): VM provision → repo/worktree rsync → state copy/discard table → `csm setup` → headless `claude` auth + `gh auth login` + `gh auth setup-git` + SSH-format commit signing → units up → PWA reinstall on iPhone (+ optionally Mac Dock) at the ts.net origin → push re-subscribe → Mac-side: install Mosh, configure `csm terminal`, retire caffeinate/launchd.
- Done: executed once for real; every scenario in `verification.md` passes on the VM; Mac bridge/monitor stopped.

**Status:** operational (VM cutover complete; device-side PWA reinstall and push reauthorization remain manual)
**Attempts:** 2 (authoring + live cutover)
**Files changed:** deploy/RUNBOOK.md, docs/adr/0015, docs/adr/0016, CLAUDE.md (matches plan)
**Done-criteria check:** VM launched and renamed to `vm`; Mosh/tmux attachment, Tailscale Serve, and the four CSM user services are live. Device-side PWA reinstall/push reauthorization remains a user action.
**Tests added/modified:** none (docs)

## inc-6 — dlm-backup (S)

- Deps: inc-4 (executes post-inc-5).
- Files: `deploy/aws/dlm-policies.sh` (aws CLI — console can't do sub-daily), `deploy/units/snapshot-check.{service,timer}`, `deploy/README.md` section; small `csm notify <msg>` subcommand in `src/cli.ts` reusing `sendWebPush` to all subscribed devices.
- Changes: per D11 — DLM policies 4-hourly/3-day + daily/14-day on the tagged volume; a timer unit checks latest-snapshot age via `aws ec2 describe-snapshots` and calls `csm notify` when stale (>5h); measure `FullSnapshotSizeInBytes` deltas for a day before considering hourly; action-enabled AWS Budget that stops the instance (D6 guardrail) created here too.
- Done: `aws dlm get-lifecycle-policies` shows both schedules and snapshots accrue on cadence; a test restore (volume from snapshot → mount → diff one repo) matches; suspending the DLM policy triggers the staleness push on the phone within the check window.

**Status:** operational with follow-ups (both DLM policies are enabled; budget action and restore drill remain)
**Attempts:** 2 (authoring + AWS deployment)
**Files changed:** deploy/aws/dlm-policies.sh, deploy/units/snapshot-check.{service,timer}, deploy/README.md, src/cli.ts + bin/csm.ts (`csm notify`), src/core/web-push.ts (`listDeviceIds`) (matches plan)
**Done-criteria check:** artifacts verified (evidence: /tmp/hawk-implement-plan-verify-inc6.log — shellcheck 0, 623 tests pass, notify error paths exercised under isolated CSM_HOME). Both DLM lifecycle policies are enabled. An action-enabled `vm-stop` budget and a restore-and-diff drill are still outstanding.
**Tests added/modified:** none new (notify error paths exercised via CLI; the push path reuses the RFC-8291 code already pinned by web-push tests)
