# deploy/ — CSM on an always-on Linux host

Provisioning for running the whole CSM stack (tmux + Claude Code sessions + the
portkey bridge) on a headless Ubuntu 24.04 VM, with the Mac and iPhone as thin
clients over Tailscale. The cutover itself (state copy, auth, PWA reinstall) is
`RUNBOOK.md`; decision records are ADRs 14–16.

## Contents

| File | Purpose |
|---|---|
| `provision.sh` | Idempotent host setup — packages, inotify sysctl, swap, TZ, journald cap, needrestart list-only, bubblewrap AppArmor profile, linger + user units, bridge token, tmux snippet, tailscale install/serve. Re-run any time. |
| `units/tmux.service` | User unit: tmux server at boot (linger), `csm save-sessions` on stop. |
| `units/csm-bridge.service` | User unit: the bridge, `Restart=always` with spaced retries, token via 0600 `EnvironmentFile`. |
| `units/csm-monitor.service` | User unit: fallback monitor tick + resurrect autosave while no tmux client is attached (status-right — and continuum riding it — only runs for attached clients). |
| `tmux-vm.conf` | Remote-client tmux settings (escape-time, window-size, OSC 52). Sourced from `~/.tmux.conf`. |
| `aws/dlm-policies.sh` | DLM snapshot schedules (4-hourly/3d + daily/14d on `csm-backup=true` volumes) + budget-stop guardrail pointer. CLI-only — the console can't do sub-daily. |
| `units/snapshot-check.{service,timer}` | Hourly staleness probe: newest `csm-backup` snapshot older than 5h → `csm notify` pushes to the phone. Needs the aws CLI and an instance role with `ec2:DescribeSnapshots`. |

## Usage

```sh
./provision.sh --tz Europe/Madrid --swap-gb 16
```

Run as the login user; system steps use sudo. Steps needing live systemd or
tailscaled are skipped with a `[provision skip]` line when unavailable (container
smoke-tests), so watch the output — a skip on a real VM is a problem.

Prerequisites the script checks but cannot create:

- **The user's home must be `/Users/<name>`** (created at launch: `sudo mkdir -p
  /Users && sudo useradd -m -d /Users/<name> -s /usr/bin/zsh <name>` — useradd does
  NOT create the `/Users` parent itself). Claude Code encodes the absolute cwd into
  transcript directory names; matching the Mac's `/Users/...` layout byte-for-byte
  is what lets copied sessions resume (ADR 15).
- **Tailscale join** is interactive by design: `sudo tailscale up --ssh
  --hostname=<name> --authkey=<key>`. Use a **pre-tagged auth key** — tagging after
  join does not disable key expiry, and an expired node key strands the box.
- **bun + csm + claude** installs are in the runbook (they're user-level, not host
  provisioning).

## After a reboot

Everything must come back with no SSH login (linger): `systemctl --user status
tmux csm-bridge csm-monitor` from an SSH one-liner, `tailscale serve status` shows
8473, and the phone reaches the bridge. That's verification scenario 4; scenario 8
covers session restore (resurrect's restore from tmux.service's `ExecStartPost`,
whose post-restore hook runs `csm restore-sessions`).
