#!/usr/bin/env bash
# Read-only health check for a provisioned CSM Linux host. It deliberately never
# prints credentials or the bridge token.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CSM_TMUX_SOURCE="if-shell 'test -f ~/.config/csm/tmux.conf' 'source-file ~/.config/csm/tmux.conf' ''"
# Literal line expected in the user's zsh configuration.
# shellcheck disable=SC2016
CSM_ZSH_SOURCE='[[ -r "$HOME/.config/csm/shell.zsh" ]] && source "$HOME/.config/csm/shell.zsh"'

failures=0
warnings=0

pass() { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[fail]\033[0m %s\n' "$*"; failures=$((failures + 1)); }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; warnings=$((warnings + 1)); }

expect_eq() {
  local label="$1" actual="$2" wanted="$3"
  if [ "$actual" = "$wanted" ]; then
    pass "$label = $wanted"
  else
    fail "$label = ${actual:-<empty>} (expected $wanted)"
  fi
}

printf 'CSM Linux service doctor\n\n'

case "$(uname -s)" in
  Linux) pass "host is Linux ($(uname -m))" ;;
  *) fail "host is $(uname -s), not Linux" ;;
esac
case "$HOME" in
  /Users/*) pass "home-directory parity: $HOME" ;;
  *) fail "HOME is $HOME; copied Claude sessions expect /Users/<name>" ;;
esac

for cmd in tmux mosh-server zsh git gh jq curl bun csm claude bwrap socat lsof; do
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "$cmd: $(command -v "$cmd")"
  else
    fail "$cmd is not installed or not on the login PATH"
  fi
done

if [ -d /run/systemd/system ]; then
  for unit in tmux.service csm-bridge.service csm-monitor.service csm-daemon.service snapshot-check.timer; do
    active=$(systemctl --user is-active "$unit" 2>/dev/null || true)
    enabled=$(systemctl --user is-enabled "$unit" 2>/dev/null || true)
    expect_eq "$unit active" "$active" active
    expect_eq "$unit enabled" "$enabled" enabled
  done
  linger=$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)
  expect_eq "login linger" "$linger" yes
else
  fail "systemd is not running"
fi

if tmux has-session -t main 2>/dev/null; then
  pass "tmux session main is alive"

  tmux_path=$(tmux show-environment -g PATH 2>/dev/null | sed -n 's/^PATH=//p')
  if [[ ":$tmux_path:" == *":$HOME/.bun/bin:"* && ":$tmux_path:" == *":$HOME/.local/bin:"* ]]; then
    pass "tmux server PATH includes bun and local bins"
  else
    fail "tmux server PATH is missing $HOME/.bun/bin or $HOME/.local/bin: $tmux_path"
  fi
  if PATH="$tmux_path" command -v csm >/dev/null 2>&1; then
    pass "tmux run-shell can resolve csm"
  else
    fail "csm is not resolvable through the tmux server PATH"
  fi

  csm_status=$(tmux show-options -gqv @csm_status 2>/dev/null || true)
  if [[ "$csm_status" == *"csm status"* ]]; then pass "CSM status segment is active"; else fail "@csm_status is missing or inactive"; fi
  csm_popup=$(tmux list-keys -T prefix a 2>/dev/null || true)
  if [[ "$csm_popup" == *"display-popup"* && "$csm_popup" == *"csm"* ]]; then pass "CSM popup binding is active"; else fail "prefix+a is not bound to the CSM popup"; fi

else
  fail "tmux session main is not alive"
fi

if cmp -s "$here/../config/tmux.conf" "$HOME/.config/csm/tmux.conf" 2>/dev/null; then
  pass "current CSM-owned tmux fragment is installed"
else
  fail "CSM-owned tmux fragment is missing or stale: $HOME/.config/csm/tmux.conf"
fi
if grep -Fxq "$CSM_TMUX_SOURCE" "$HOME/.tmux.conf" 2>/dev/null; then
  pass "$HOME/.tmux.conf imports the CSM fragment"
else
  fail "$HOME/.tmux.conf does not import the CSM fragment"
fi
if cmp -s "$here/../config/shell.zsh" "$HOME/.config/csm/shell.zsh" 2>/dev/null; then
  pass "current CSM-owned zsh fragment is installed"
else
  fail "CSM-owned zsh fragment is missing or stale: $HOME/.config/csm/shell.zsh"
fi
if grep -Fxq "$CSM_ZSH_SOURCE" "$HOME/.zshrc" 2>/dev/null; then
  pass "$HOME/.zshrc imports the CSM fragment"
else
  fail "$HOME/.zshrc does not import the CSM fragment"
fi

csm_config="$HOME/.config/csm/config.json"
if jq -e '.schemaVersion == 1 and (.repositories.roots | type == "array") and (.repositories.roots | length > 0)' "$csm_config" >/dev/null 2>&1; then
  pass "single-file CSM config is valid: $csm_config"
else
  fail "missing or invalid schemaVersion 1 CSM config: $csm_config"
fi

if gh auth status >/dev/null 2>&1; then
  pass "GitHub CLI is authenticated"
else
  fail "GitHub CLI is not authenticated"
fi
if claude auth status 2>/dev/null | jq -e '.loggedIn == true' >/dev/null 2>&1; then
  pass "Claude Code is authenticated"
else
  fail "Claude Code is not authenticated"
fi

bridge_env="$HOME/.config/csm/bridge.env"
if [ -r "$bridge_env" ]; then
  # Generated EnvironmentFile at a fixed local path.
  set -a
  # shellcheck disable=SC1090
  . "$bridge_env"
  set +a
  if [ -n "${CSM_BRIDGE_TOKEN:-}" ]; then
    payload=$(jq -cn --arg token "$CSM_BRIDGE_TOKEN" '{token:$token}')
    code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      -H 'content-type: application/json' --data-binary "$payload" \
      http://127.0.0.1:8473/auth 2>/dev/null || true)
    expect_eq "bridge authentication" "$code" 200
    unset CSM_BRIDGE_TOKEN payload
  else
    fail "bridge EnvironmentFile has no CSM_BRIDGE_TOKEN"
  fi
else
  fail "bridge EnvironmentFile is missing or unreadable: $bridge_env"
fi

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  pass "Tailscale is connected"
  if tailscale serve status 2>/dev/null | grep -q '127.0.0.1:8473'; then
    pass "Tailscale Serve proxies the portkey bridge"
  else
    fail "Tailscale Serve is not proxying 127.0.0.1:8473"
  fi
else
  fail "Tailscale is not connected"
fi

watchers=$(sysctl -n fs.inotify.max_user_watches 2>/dev/null || true)
instances=$(sysctl -n fs.inotify.max_user_instances 2>/dev/null || true)
if [ "${watchers:-0}" -ge 1048576 ] 2>/dev/null; then pass "inotify watches = $watchers"; else fail "inotify watches = ${watchers:-unknown}"; fi
if [ "${instances:-0}" -ge 16384 ] 2>/dev/null; then pass "inotify instances = $instances"; else fail "inotify instances = ${instances:-unknown}"; fi
if swapon --show 2>/dev/null | grep -q '^/swapfile'; then pass "swapfile is active"; else fail "swapfile is not active"; fi

printf '\nDoctor finished: %d failure(s), %d warning(s).\n' "$failures" "$warnings"
[ "$failures" -eq 0 ]
