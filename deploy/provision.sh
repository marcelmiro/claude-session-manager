#!/usr/bin/env bash
# Provision an Ubuntu 24.04 host to run the CSM stack (tmux + Claude Code sessions +
# mobile bridge) headlessly. Idempotent: safe to re-run; every step checks before it
# changes. Run as the login user (not root) — system steps use sudo.
#
#   ./provision.sh [--tz <IANA zone>] [--swap-gb <n>]
#
# Steps that need a live systemd/tailscaled are skipped with a warning when absent
# (containers, CI), so the file/package layer can be smoke-tested anywhere.
set -euo pipefail

TZ_WANTED="Europe/Madrid"
SWAP_GB=16
while [ $# -gt 0 ]; do
  case "$1" in
    --tz) TZ_WANTED="$2"; shift 2 ;;
    --swap-gb) SWAP_GB="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
have() { command -v "$1" >/dev/null 2>&1; }
note() { printf '\033[36m[provision]\033[0m %s\n' "$*"; }
skip() { printf '\033[33m[provision skip]\033[0m %s\n' "$*"; }

# ── 0. Home-directory parity check ─────────────────────────────────────────────
# Claude Code encodes the ABSOLUTE cwd into ~/.claude/projects/<encoded>/ dir names,
# so transcripts copied from the Mac only resolve if $HOME matches its /Users/<user>
# form byte-for-byte. The user must be created that way at launch (useradd -m -d
# /Users/<name>); this can only be verified after the fact.
case "$HOME" in
  /Users/*) note "home-directory parity OK ($HOME)" ;;
  *) skip "HOME is $HOME, not /Users/<name> — copied Claude transcripts will not resolve; see deploy/RUNBOOK.md for the rename-pass fallback" ;;
esac

# ── 1. Packages ────────────────────────────────────────────────────────────────
# lsof: background-script liveness probes. bubblewrap+socat: Claude Code's Linux
# sandbox — WITHOUT them it silently runs unsandboxed while autoAllowBashIfSandboxed
# defaults true. earlyoom: kills the largest process instead of a whole cgroup (a
# leaky Claude session dies, the tmux server survives).
PKGS=(tmux zsh lsof git gh curl jq bubblewrap socat earlyoom unzip)
missing=()
for p in "${PKGS[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if [ ${#missing[@]} -gt 0 ]; then
  note "installing: ${missing[*]}"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}"
else
  note "packages already present"
fi

# ── 2. inotify limits ──────────────────────────────────────────────────────────
# Per-UID and shared by every Claude session; exhaustion is a hard ENOSPC crash with
# no graceful degradation. max_user_instances (default 128) breaks first.
SYSCTL_FILE=/etc/sysctl.d/99-csm-inotify.conf
if [ ! -f "$SYSCTL_FILE" ]; then
  note "writing $SYSCTL_FILE"
  sudo tee "$SYSCTL_FILE" >/dev/null <<'EOF'
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 16384
fs.inotify.max_queued_events = 32768
EOF
  sudo sysctl --system >/dev/null || true
else
  note "inotify sysctl already present"
fi

# ── 3. Swap ────────────────────────────────────────────────────────────────────
# Cloud images ship swapless; a swapless box livelocks under memory pressure instead
# of degrading. Claude Code leaks — swap is the buffer earlyoom needs to act sanely.
if ! swapon --show | grep -q '^/swapfile'; then
  if [ -d /run/systemd/system ]; then
    note "creating ${SWAP_GB}G swapfile"
    sudo fallocate -l "${SWAP_GB}G" /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile >/dev/null
    sudo swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  else
    skip "no systemd (container?) — skipping swapfile"
  fi
else
  note "swapfile already active"
fi

# ── 4. Timezone ────────────────────────────────────────────────────────────────
# CSM's 24h archive window and staleness heuristics are wall-clock sensitive; cloud
# images default to UTC.
if have timedatectl && [ -d /run/systemd/system ]; then
  current_tz=$(timedatectl show -p Timezone --value)
  if [ "$current_tz" != "$TZ_WANTED" ]; then
    note "timezone $current_tz → $TZ_WANTED"
    sudo timedatectl set-timezone "$TZ_WANTED"
  else
    note "timezone already $TZ_WANTED"
  fi
else
  skip "no timedatectl/systemd — skipping timezone"
fi

# ── 5. journald cap ────────────────────────────────────────────────────────────
JOURNAL_FILE=/etc/systemd/journald.conf.d/csm.conf
if [ ! -f "$JOURNAL_FILE" ]; then
  note "capping journald at 500M"
  sudo mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nSystemMaxUse=500M\n' | sudo tee "$JOURNAL_FILE" >/dev/null
  [ -d /run/systemd/system ] && sudo systemctl restart systemd-journald || true
else
  note "journald cap already present"
fi

# ── 6. needrestart: list-only ──────────────────────────────────────────────────
# Since 24.04 needrestart auto-restarts services after unattended-upgrades and can
# reach into user managers. 'l' = list only ('i' can still prompt and hang a job).
NEEDRESTART_FILE=/etc/needrestart/conf.d/50-csm.conf
if [ -d /etc/needrestart ] && [ ! -f "$NEEDRESTART_FILE" ]; then
  note "setting needrestart to list-only"
  printf "\$nrconf{restart} = 'l';\n" | sudo tee "$NEEDRESTART_FILE" >/dev/null
else
  note "needrestart config present or needrestart not installed"
fi

# ── 7. AppArmor profile for bubblewrap ─────────────────────────────────────────
# Ubuntu 24.04 blocks unprivileged user namespaces by default; without this profile
# the Claude Code sandbox cannot start (and its absence is silent).
APPARMOR_FILE=/etc/apparmor.d/bwrap
if [ -d /etc/apparmor.d ] && [ ! -f "$APPARMOR_FILE" ]; then
  note "installing bwrap AppArmor profile"
  sudo tee "$APPARMOR_FILE" >/dev/null <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
EOF
  have apparmor_parser && sudo apparmor_parser -r "$APPARMOR_FILE" || true
else
  note "bwrap AppArmor profile present or apparmor absent"
fi

# ── 8. Linger + systemd user units ─────────────────────────────────────────────
# Without linger, logind kills the whole tmux server (and every Claude session in
# it) when the last SSH session closes — the single config that silently destroys
# the setup. Units are user-scoped: WantedBy=default.target (multi-user.target does
# not exist in the user instance and the unit would silently never start).
if [ -d /run/systemd/system ]; then
  if [ ! -e "/var/lib/systemd/linger/$USER" ]; then
    note "enabling linger for $USER"
    sudo loginctl enable-linger "$USER"
  else
    note "linger already enabled"
  fi

  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  for unit in tmux.service csm-bridge.service csm-monitor.service csm-daemon.service snapshot-check.service snapshot-check.timer; do
    if ! cmp -s "$here/units/$unit" "$UNIT_DIR/$unit" 2>/dev/null; then
      note "installing user unit $unit"
      cp "$here/units/$unit" "$UNIT_DIR/$unit"
    fi
  done

  # Bridge token: generated once, consumed by csm-bridge.service via EnvironmentFile.
  BRIDGE_ENV="$HOME/.config/csm/bridge.env"
  if [ ! -f "$BRIDGE_ENV" ]; then
    note "minting bridge token → $BRIDGE_ENV"
    mkdir -p "$HOME/.config/csm"
    printf 'CSM_BRIDGE_TOKEN=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 43)" > "$BRIDGE_ENV"
    chmod 600 "$BRIDGE_ENV"
  fi

  systemctl --user daemon-reload
  systemctl --user enable tmux.service csm-bridge.service csm-monitor.service csm-daemon.service snapshot-check.timer >/dev/null 2>&1 || true
else
  skip "no systemd — skipping linger, user units, bridge token"
fi

# ── 9. tmux config for remote clients ──────────────────────────────────────────
TMUX_SNIPPET="$HOME/.config/csm/tmux-vm.conf"
mkdir -p "$HOME/.config/csm"
if ! cmp -s "$here/tmux-vm.conf" "$TMUX_SNIPPET" 2>/dev/null; then
  note "installing tmux snippet → $TMUX_SNIPPET"
  cp "$here/tmux-vm.conf" "$TMUX_SNIPPET"
fi
SOURCE_LINE="source-file $TMUX_SNIPPET"
if [ ! -f "$HOME/.tmux.conf" ] || ! grep -qF "$SOURCE_LINE" "$HOME/.tmux.conf"; then
  note "sourcing snippet from ~/.tmux.conf"
  printf '\n%s\n' "$SOURCE_LINE" >> "$HOME/.tmux.conf"
fi

# ── 9b. tmux persistence plugins ───────────────────────────────────────────────
# resurrect (layout save/restore) + continuum (restore on server start). The csm
# save/restore hooks are wired in tmux-vm.conf; restore fires when the systemd
# unit starts the server after a reboot.
PLUGIN_DIR="$HOME/.tmux/plugins"
mkdir -p "$PLUGIN_DIR"
for plugin in tmux-resurrect tmux-continuum; do
  if [ ! -d "$PLUGIN_DIR/$plugin" ]; then
    note "cloning $plugin"
    git clone -q --depth 1 "https://github.com/tmux-plugins/$plugin" "$PLUGIN_DIR/$plugin"
  fi
done

# ── 10. Tailscale ──────────────────────────────────────────────────────────────
if ! have tailscale; then
  note "installing tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if [ -d /run/systemd/system ] && have tailscale; then
  if ! tailscale status >/dev/null 2>&1; then
    skip "tailscale not up — join with: sudo tailscale up --ssh --hostname=<name> --authkey=<pre-tagged key>  (tag at JOIN time or key expiry stays on)"
  else
    if ! tailscale serve status 2>/dev/null | grep -q 8473; then
      note "enabling tailscale serve for the bridge"
      sudo tailscale serve --bg 8473
    else
      note "tailscale serve already proxying 8473"
    fi
  fi
else
  skip "no systemd/tailscale daemon — skipping tailscale up/serve"
fi

note "done. Reboot once to prove unit autostart (verification scenario 4)."
