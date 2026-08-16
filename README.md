# CSM — Claude Session Manager

CSM is a tmux-based workspace for running and monitoring multiple Claude Code
sessions. It supports two independent modes:

- **Local:** CSM, tmux, and Claude run on the current computer.
- **Remote:** a Mac or Linux client uses Mosh to attach to an always-on Linux CSM
  host. tmux owns session persistence; the client is only a terminal.

## Install CSM on a computer

Requirements: [Bun](https://bun.sh), tmux, zsh, Git, jq, and Claude Code. Remote
mode also requires Mosh on the client and host.

```sh
mkdir -p ~/dev
git clone https://github.com/marcelmiro/claude-session-manager ~/dev/csm
cd ~/dev/csm
bun install
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/csm.ts" ~/.local/bin/csm
csm setup
```

`csm setup` is idempotent. It installs Claude hooks plus CSM-owned extensions at:

```text
~/.config/csm/tmux.conf
~/.config/csm/shell.zsh
~/.config/csm/terminal-launcher  # private transport implementation
~/.local/bin/csm
```

It adds one import line to `~/.tmux.conf` and `~/.zshrc`; it does not replace
personal dotfiles.

### Migrating an existing `~/Documents` installation

Do not move repositories or rename the account with plain `mv`: Git worktree
metadata and Claude transcript identities contain absolute paths. Generate a
collision/dirty-submodule manifest first, then use the two-phase cutover guide:

```sh
bun run scripts/migrate-dev-layout.ts preflight --target-home /Users/marcel
scripts/migrate-dev-layout-wizard.sh prepare
```

The wizard resumes with `finish` after the required macOS logout. The apply phase
keeps path-state backups under `~/.config/csm/migrations/`. See
[ADR 17](docs/adr/0017-user-centric-development-layout.md) for the invariants.

## One user config

```sh
# Print the absolute path, creating the documented defaults on first use:
csm config

# Edit it with any editor:
${EDITOR:-vim} "$(csm config)"
```

CSM has one machine-local, schema-backed settings file. Repository discovery,
terminal attachment, UI, and notification preferences all live in that file; CSM
does not maintain hidden sidecar settings. The default repository layout is flat:
`~/dev/<repo>`. Set `repositories.priority` only when you want selected repos pinned.

## Local and remote terminal modes

Set `terminal.defaultTarget` and `terminal.remoteHost` in `$(csm config)`, then:

```sh
# Explicit invocations do not mutate the default:
csm terminal local
csm terminal remote
csm terminal status

# No argument uses terminal.defaultTarget:
csm terminal
```

On macOS, Ghostty invokes the CSM command so a failed connection or detach falls
through to a local login shell:

```text
/bin/zsh -lc '"$HOME/.local/bin/csm" terminal; exec /bin/zsh -l'
```

Remote mode requires Mosh on both machines. Hostname, mode, and session choices
are fields in the machine-local `~/.config/csm/config.json`, never committed to dotfiles.
The remote Mosh server keeps a reconnect window of 30 days so ordinary laptop
sleep, roaming, and travel do not strand an open terminal.

On Linux, CSM provides a compact interactive zsh baseline and then sources
`~/.zshrc.local` when present. Put personal prompt/theme setup there; `csm setup`
updates its own fragment without overwriting that file.

## Provision an always-on Linux host

Ubuntu 24.04 hosts are self-contained and do not need personal dotfiles:

```sh
cd ~/dev/csm
./deploy/provision.sh --tz Europe/Madrid --swap-gb 16
csm setup
./deploy/doctor.sh
```

See [deploy/README.md](deploy/README.md) for prerequisites and
[deploy/RUNBOOK.md](deploy/RUNBOOK.md) for a full VM cutover.
