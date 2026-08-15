# Cutover runbook — Mac → Linux VM

Ordered, one sitting (~2h active). The Mac keeps working until phase F, so nothing
is burned before the VM is proven. State dispositions come from the migration
table in the plan (copy vs regenerate vs discard); decisions: ADRs 14–16.

## A. Launch (AWS, eu-central-1)

1. Instance: **r7i.2xlarge**, Ubuntu 24.04 LTS x86 AMI, EBS-only (no instance
   store). gp3 sized ~3× the measured data (63 GB → **200 GB**, baseline IOPS;
   growth is one online `modify-volume`, shrink is impossible). Security group:
   **no inbound** except UDP 41641 (Tailscale direct); all egress open — plus a
   TEMPORARY tcp/22 rule from your current IP for phases A–C, revoked once
   Tailscale SSH works.
2. IMDSv2: `--metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2"`
   (plain-API r7i launches still default to optional).
3. First boot, as `ubuntu`:
   ```sh
   sudo mkdir -p /Users && sudo useradd -m -d /Users/throxy -s /usr/bin/zsh throxy   # ADR 15; useradd won't create /Users itself
   echo 'throxy ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/throxy
   sudo install -d -m 700 -o throxy /Users/throxy/.ssh
   sudo cp ~/.ssh/authorized_keys /Users/throxy/.ssh/ && sudo chown throxy /Users/throxy/.ssh/authorized_keys
   ```
4. NVMe timeout (an EBS blip can remount the FS read-only at the 30s default):
   `nvme_core.io_timeout=4294967295` appended to `GRUB_CMDLINE_LINUX` in
   `/etc/default/grub`, then `sudo update-grub`. Verify any extra volumes mount by
   UUID with `nofail`.
5. Reboot once; log in as `throxy`.

## B. Provision

```sh
git clone https://github.com/marcelmiro/claude-session-manager ~/Documents/csm
~/Documents/csm/deploy/provision.sh --tz Europe/Madrid --swap-gb 16
curl -fsSL https://bun.sh/install | bash                       # bun → ~/.bun/bin
cd ~/Documents/csm && bun install && ln -sf ~/Documents/csm/bin/csm.ts ~/.bun/bin/csm
curl -fsSL https://claude.ai/install.sh | bash -s stable       # claude (self-updating channel)
csm setup                                                     # hooks + tmux/zsh fragments
sudo tailscale up --ssh --hostname=<name> --authkey=<PRE-TAGGED key>   # tag at join or expiry stays on
sudo tailscale serve --bg 8473
```

To inherit the Mac's tailnet hostname, rename/remove the Mac node FIRST — a
collision silently mints `<name>-1` and the phone points at the wrong origin.

## C. Auth (all headless-capable)

- `claude` → press `c` to copy the login URL, open on the phone/Mac, paste code back.
- `gh auth login --git-protocol https` (device flow) then `gh auth setup-git`.
- Commit signing → SSH format (gpg-agent blocks forever on headless pinentry):
  ```sh
  ssh-keygen -t ed25519 -f ~/.ssh/signing -N ''
  git config --global gpg.format ssh
  git config --global user.signingkey ~/.ssh/signing.pub
  ```
- Guardrail (load-bearing): PR-required ruleset on `main` in the repos the agent
  pushes to. The VM's key is functionally a deploy key.

## D. State copy (Mac → VM)

On the Mac (VM reachable as `vm` over Tailscale):

```sh
launchctl bootout gui/$UID/com.csm.daemon                             # stop the inbox daemon first (also teardown, below)
sqlite3 ~/.config/csm/inbox.db "PRAGMA wal_checkpoint(TRUNCATE);"     # fold WAL into the db file before copying it
rsync -a --info=progress2 ~/Documents/ vm:Documents/                  # repos + worktrees, same abs path (ADR 15)
rsync -a ~/.claude/projects/ vm:.claude/projects/                     # transcripts resolve as-is
scp ~/.config/csm/config.json ~/.config/csm/names.json ~/.config/csm/push-vapid.json ~/.config/csm/inbox.db vm:.config/csm/
```

`inbox.db` carries the authored inbox state — open snoozes, block notes, the
event history behind the ✓ scoreboard. A snooze pending at cutover must wake on
the VM (repo paths inside stay valid via `/Users` parity; the activity snapshot
table self-rebuilds on the VM's first discovery tick).

Do NOT copy: `push-subscriptions.json` (origin-bound — dead at the new origin),
`state.json`, `panes/`, `hook-events`, `resurrect-sessions.json`, `verdicts/`,
`script-wait.json`, `consumers/ source/ pushed/ pending/ decisions/` (all
host-local or transient), `~/.claude/.credentials.json` (fresh login, phase C),
`~/.claude/settings.json` (next line regenerates hooks at the current version).

Then on the VM: `csm setup`.

## E. Bring up + verify

```sh
systemctl --user daemon-reload && systemctl --user start tmux csm-bridge csm-monitor csm-daemon snapshot-check.timer
```

Run verification scenarios **4** (reboot with no SSH → everything back), **5/6**
(presence: typing suppresses pushes; idle attach routes approvals/questions to the
phone), **8** (reboot with live sessions → `csm restore-sessions` resumes each,
no duplicate claude per pane), **9** (Space→c over Mosh lands in the Mac
clipboard), **7** (phone lists sessions, resume works, push round-trips).

## F. Point the clients at it

- iPhone: Tailscale app → VPN On Demand → cellular **Always**. Delete the old
  portkey icon; open `https://<vm>.<tailnet>.ts.net`, Add to Home Screen, re-grant
  push (the bell — permission needs the tap), confirm a test push.
- Mac: `brew install mosh`; run `csm setup`, then configure the client with
  `csm terminal host <vm.ts.net>` and `csm terminal default remote`. Ghostty runs
  `csm terminal` at startup; `csm terminal local` remains available
  for a completely separate Mac-local CSM/tmux environment.
  `shell-integration-features = ssh-env,ssh-terminfo`, `clipboard-write = allow`.
- Mac teardown: stop the launchd bridge / `caffeinate` wrapper, remove the plist,
  stop the monitor, and boot out the inbox daemon (`launchctl bootout
  gui/$UID/com.csm.daemon` + delete `~/Library/LaunchAgents/com.csm.daemon.plist`
  — two daemons against two tmux servers means two divergent inboxes). Leave
  `~/.config/csm` and repos in place as the rollback seed.
- Flip CLAUDE.md's "Bridge restarts" section to the systemd procedure
  (`systemctl --user restart csm-bridge`, log: `journalctl --user -u csm-bridge`),
  keeping the darwin procedure as a footnote (ADR 16).

## G. Rollback (valid ~days)

Stop VM units → restart Mac monitor/bridge (old instructions) → reinstall the PWA
at the Mac origin → rsync back only `~/.claude/projects/` deltas for sessions
touched on the VM. The Mac's untouched `~/.config/csm` does the rest. After the
window, restore from the VM's EBS snapshots instead (the DLM schedules in
`aws/dlm-policies.sh`).
