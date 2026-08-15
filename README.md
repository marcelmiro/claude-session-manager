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
git clone https://github.com/marcelmiro/claude-session-manager ~/Documents/csm
cd ~/Documents/csm
bun install
mkdir -p ~/.local/bin
ln -sf "$PWD/bin/csm.ts" ~/.local/bin/csm
csm setup
```

`csm setup` is idempotent. It installs Claude hooks plus CSM-owned extensions at:

```text
~/.config/csm/tmux.conf
~/.config/csm/shell.zsh
~/.local/bin/csm-terminal
```

It adds one import line to `~/.tmux.conf` and `~/.zshrc`; it does not replace
personal dotfiles.

## Local and remote terminal modes

```sh
# Make new terminal windows use local tmux:
csm-terminal use local

# Or configure an always-on host and make it the default:
csm-terminal host csm-vm.example.ts.net
csm-terminal use remote

# Open either mode explicitly without changing the default:
csm-local
csm-remote

csm-terminal status
```

On macOS, Ghostty can use this command so a failed connection or detach falls
through to a local login shell:

```text
/bin/zsh -lc '"$HOME/.local/bin/csm-terminal"; exec /bin/zsh -l'
```

Remote mode requires Mosh on both machines. Hostname, mode, and session choices
are machine-local files under `~/.config/csm/`, never committed to dotfiles.

## Provision an always-on Linux host

Ubuntu 24.04 hosts are self-contained and do not need personal dotfiles:

```sh
cd ~/Documents/csm
./deploy/provision.sh --tz Europe/Madrid --swap-gb 16
csm setup
./deploy/doctor.sh
```

See [deploy/README.md](deploy/README.md) for prerequisites and
[deploy/RUNBOOK.md](deploy/RUNBOOK.md) for a full VM cutover.
