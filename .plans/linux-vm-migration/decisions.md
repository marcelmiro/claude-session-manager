# Decisions — linux-vm-migration

## D1 — Presence = tmux client activity on Linux; darwin untouched
Linux has no "Ghostty frontmost". Presence becomes: attached tmux client with `client_activity` within 60s, centralized in tri-state `core/presence.ts`; each of the five call sites maps `unknown` per its existing hand-tuned failure polarity (see inc-2-notes). Darwin keeps today's probes verbatim — never degrade the working desk behavior. **Rejected**: Mac-side frontmost-heartbeat agent (new component to install/keep alive; user chose activity for v1 — revisit only if redundant desk pushes annoy); presence marker file (nothing to go stale if computed live).
Accepted risk: reading-without-typing counts as absent after 60s.

## D2 — Desk notification tier deferred; tier 3 becomes darwin-only
User decision. At the desk you're tmux-attached: ⚡ prefixes + status-right + `csm next` cover it; the phone keeps tier-4 web push. `sendNativeNotification` is gated behind `process.platform === "darwin"` instead of ported. **Recorded follow-up**: Mac Dock-PWA as a push device (Safari supports W3C push for Dock-installed PWAs) with an "always-notify" flag — needs the source-attribution gate widened; not in this plan.

## D3 — Cross-platform, not a Linux fork
User decision. All changes are platform branches (`process.platform` / `uname`), CSM stays fully working and testable on macOS. Cost: a few dual paths; benefit: dev-on-Mac continues, road back stays open.

## D4 — PWA origin = the VM's ts.net name; no custom domain
User decision (plan argument). Devices reinstall the PWA at `https://<vm>.<tailnet>.ts.net` once and re-grant push. `push-vapid.json` carries over (VAPID is origin-independent); `push-subscriptions.json` is discarded (subscriptions are origin-bound). **Known cost**: the next host move repeats the reinstall dance. **Rejected for now**: own domain + Caddy DNS-01 (permanent origin) — revisit if a second migration ever looms. Tailscale gotcha honored: bring the VM up with the desired hostname before any name collision mints `-1`.

## D5 — Transport: Mosh default, SSH fallback
CSM's internal terminal launcher owns the client connection and uses Mosh for roaming and sleep/wake resilience; users control it through the `csm terminal ...` command group. The selected host and local/remote mode are machine-local state under `~/.config/csm/`, so dotfiles contain no personal tailnet hostname. Plain SSH remains the diagnostic fallback; tmux owns session persistence either way. Eternal Terminal was prototyped during the migration and retired before cutover.

## D6 — AWS: r7i.2xlarge, eu-central-1, gp3 200GB, on-demand; resize on measured pressure
The deployed host is an encrypted, EBS-only Ubuntu 24.04 `r7i.2xlarge` (8 vCPU / 64 GiB) in eu-central-1 with a 200 GB gp3 root volume. The disk was right-sized from the measured working set instead of the original 800 GB estimate; it can grow online. Instance sizing remains measurement-driven: resize only when swap pressure or earlyoom kills justify it. Standing rationale: **x86 not ARM** (avoid architecture-specific toolchain failures), **r-family not m** (the workload is RAM-heavy), and **on-demand while credits last**. IMDSv2 is required, EBS mounts use UUID plus `nofail`, and `nvme_core.io_timeout=4294967295` protects against transient EBS detach behavior. An **action-enabled AWS Budget that stops the instance is still an operational follow-up**; DLM backups do not provide a spend cutoff.

## D11 — Backup = DLM-managed EBS snapshots, not restic (AWS-specific reversal)
On Hetzner, restic earned its keep (client-side encryption vs unencrypted provider snapshots, hourly granularity). On AWS: DLM is free, the CLI (not console) accepts `Interval: 1 HOURS`, snapshots are incremental ($0.054/GB-mo) and encrypted when the volume is, and restore is one API call to a bootable volume. Policy: **4-hourly / 3-day retention + daily / 14-day** (~$15–20/mo). Loud-failure requirement keeps `csm notify`: a timer checks latest-snapshot age and pushes when stale. Cautions honored: measure block-rewrite churn for a day before going more frequent (build caches inflate incremental snapshots); no Fast Snapshot Restore ($643/mo); if file-level restic is ever added anyway → S3 **Standard** only (IA/Glacier minimums fight `prune`). **Rejected**: restic-primary (agent + schedule + restore drills for ~$15/mo saved), io2 Block Express (~$310/mo for database concerns).

## D7 — Git/auth posture on the VM
`gh auth login` device flow + `gh auth setup-git` (keys must live on the VM — agent forwarding dies exactly when the Mac sleeps); commit signing switches to SSH-format (headless gpg-agent blocks on pinentry). Load-bearing control is a **PR-required ruleset on `main`** — which matches the user's existing "only I merge to main" rule. **Rejected for v1**: GitHub App with 1h installation tokens (stronger — rulesets can exempt an App but not a PAT — but ~40 lines of JWT plumbing; recorded as the hardening upgrade). Claude credentials: fresh headless login on the VM, never copied.

## D8 — systemd user units replace nohup/caffeinate/launchd
`loginctl enable-linger` + tmux and bridge as user units (`WantedBy=default.target`). Retires: `caffeinate` wrapper, launchd plist, the `nohup … & disown` restart dance, and the `ps eww` token-recovery trick (token moves to a 0600 `EnvironmentFile`). CLAUDE.md's bridge-restart section gets rewritten in inc-5.

## D9 — Resurrect: systemd + CSM own restore; resurrect never spawns claude
On the VM, `tmux.service` starts the server and invokes resurrect from `ExecStartPost`; resurrect's post-restore hook then runs `csm restore-sessions`. Continuum auto-restore is disabled because it races tmux's forking handshake under systemd. `@resurrect-processes` must not include Claude (a fresh spawn plus CSM's `--resume` would create two processes fighting over one transcript).

## Assumptions (sourced)

- `client_activity` updates on input, not output — **verify in inc-2 lab gate** (source: tmux man page; unverified empirically).
- Bridge bind guard already admits tailnet IPs (`server.ts` ~1300, audit-confirmed) — no bridge code change for the VM.
- `tailscale serve --bg` persists across reboots in tailscaled state (Tailscale docs, agent-verified).
- Session transcripts resume by id on a new host once copied under the same `~/.claude/projects/<encoded-cwd>/` path — the encoding embeds the **absolute** cwd, so `/home/<user>` vs `/Users/throxy` would break every copied dir name. **Resolution (D10): create the VM user with home `/Users/throxy`** (`useradd -m -d /Users/throxy`) — Linux has no opinion about `/Users`; every encoded transcript dir, config path, and `repoPaths` entry then matches byte-for-byte and no re-encode pass exists to get wrong. Fallback if rejected at provisioning time: a rename pass over `~/.claude/projects/` (`-Users-throxy-…` → `-home-<user>-…`) plus repoPaths edit.

## Resolved validation and follow-ups

- The inc-2 lab gate confirmed that `client_activity` refreshes on keyboard input and not pane output, so the heartbeat-agent fallback was unnecessary.
- The eu-central-1 VM is deployed and is the authoritative host.
- DLM policies are enabled. The action-enabled `vm-stop` budget and a documented snapshot restore drill remain operational follow-ups.
