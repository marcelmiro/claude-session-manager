# Linux VM migration

## Problem

The whole dev setup (repos, Claude Code sessions, tmux, CSM TUI/monitor, portkey bridge) lives on a MacBook that must stay open and caffeinated for anything to keep running. Moving it to an always-on Linux VM (AWS, credits available) makes sessions and background scripts survive lid-close, travel, and intermittent connectivity — with the Mac and iPhone as thin clients and zero DX loss.

## Approach

CSM stays **cross-platform**: every macOS-specific path gets a Linux branch, never a fork. The audit found the codebase is already ~portable (all state `$HOME`-relative, bridge host/port env-driven, bind guard already allows tailnet IPs, web-push pure Bun). The work splits into:

1. **Mechanical portability** — lsof path, BSD `stat`, `ps` sentinel, shell hardcode, explicit-bash hooks. All currently fail *silently* on Linux.
2. **Presence redesign** — five sites answer "is the user at the Mac?" via macOS probes (osascript/lsappinfo/client-attached). On the VM, presence = **an attached tmux client with keyboard activity in the last 60s** (`client_activity`), centralized in a tri-state `core/presence.ts`; darwin keeps today's frontmost probes untouched.
3. **Clipboard** — `Space→c` emits OSC 52 (tmux DCS-wrapped) on Linux; pbcopy stays on darwin.
4. **Provisioning as code** — `deploy/` with an idempotent provision script (packages, sysctl/inotify, swap, earlyoom, TZ, needrestart), systemd user units (tmux with linger + save-on-stop, bridge with sane restart limits), Tailscale join + `serve --bg`.
5. **Cutover runbook + backup** — state copy, headless auth (claude/gh), PWA reinstall at the new `ts.net` origin (decision: no custom domain), DLM-managed EBS snapshots (4-hourly + daily) with a staleness push-on-failure.

Desk notifications (macOS tier 3) are **deferred**: at the desk you're tmux-attached (⚡ prefixes, status-right, `csm next`); the phone keeps web push. Tier 3 becomes darwin-only.

## Increment DAG

```
inc-1 portability-fixes ──► inc-2 presence-abstraction ──► inc-5 cutover-runbook
inc-3 osc52-clipboard ────────────────────────────────────►
inc-4 deploy-provisioning ────────────────────────────────►
inc-4 ──► inc-6 dlm-backup
```

inc-1..4 are independent PRs against the current Mac setup (all testable on macOS). inc-5 is the migration itself (runbook execution + verification on the VM). inc-6 hardens the now-authoritative VM.

## Risks (accepted)

- **Presence semantics change on Linux**: reading-without-typing counts as absent after 60s → occasional redundant phone push at the desk. Accepted for v1; a Mac-side frontmost heartbeat is the recorded follow-up if it annoys.
- **One box runs everything**: Claude Code leaks memory and exhausts inotify per-UID; mitigated in provisioning (swap, earlyoom, sysctl), not eliminated.
- **AWS cost after credits**: the on-demand r7i.2xlarge plus EBS has material monthly cost. Fine while credits burn; an action-enabled stop budget (still to create), an in-place resize, and a provider move (provisioning is scripted, restore from snapshot/rsync) are the recorded off-ramps.
- **Nonstandard VM home dir `/Users/throxy`** (D10 — keeps Claude's encoded transcript paths byte-identical across hosts). Linux tolerates it, but any tooling that hardcodes `/home` could misbehave; provisioned + verified explicitly in inc-4, with a rename-pass fallback recorded.

## Out of scope

Custom-domain PWA origin (user decision: re-point devices at the VM's ts.net name), Mac Dock-PWA desk notifications, GitHub App token minting (start = `gh` + PR-required ruleset on main), multi-user/multi-VM.
