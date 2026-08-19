#!/usr/bin/env bash
# One-time host cutover for the CSM → Claude0 rebrand (see RUNBOOK.md).
#
# Idempotent: every step checks the current state before acting, so a partial
# failure is resumed by re-running the script. Targets the Linux/systemd host;
# a darwin machine only needs `claude0 setup` (it retires the old launchd agent).
set -euo pipefail

OLD_CFG="$HOME/.config/csm"
NEW_CFG="$HOME/.config/claude0"
OLD_REPO="$HOME/dev/csm"
NEW_REPO="$HOME/dev/claude0"
UNIT_DIR="$HOME/.config/systemd/user"
OLD_UNITS=(csm-bridge.service csm-daemon.service csm-monitor.service)
NEW_UNITS=(claude0-bridge.service claude0-daemon.service claude0-monitor.service)
BACKUP="$HOME/claude0-cutover-backup.tgz"

note() { printf '  %s\n' "$1"; }
step() { printf '\033[1m› %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. Pre-flight ──────────────────────────────────────────────────────────────
step "pre-flight"
[[ "$(uname)" == Linux ]] || die "this script targets the Linux VM host"
command -v systemctl >/dev/null || die "no systemd on this host"
command -v jq >/dev/null || die "jq required (config.json rewrite)"
if [[ -d "$OLD_REPO/.git" ]]; then
  git -C "$OLD_REPO" diff --quiet && git -C "$OLD_REPO" diff --cached --quiet \
    || die "uncommitted changes in $OLD_REPO — commit or stash first"
fi
# Both commands are ours: setup installs ~/.local/bin/{claude0,c0}, step 6
# installs ~/.bun/bin/claude0 (the units' ExecStart) — a re-run resuming past
# step 6 must not die on its own links.
for cmd in claude0 c0; do
  existing=$(command -v "$cmd" || true)
  if [[ -n "$existing" && "$existing" != "$HOME/.local/bin/$cmd" && "$existing" != "$HOME/.bun/bin/$cmd" ]]; then
    die "a different '$cmd' is already on PATH: $existing"
  fi
done
# Personal dotfile lines invoking the old command or the @csm_status tmux
# option keep failing SILENTLY after cutover (setup only rewrites the
# Claude0-owned fragments, never personal content). `csm_` catches option
# names like @csm_status where \b\… can't (underscore is a word char).
for f in "$HOME/.tmux.conf" "$HOME/.zshrc" "$HOME"/.config/tmux/*.conf; do
  hits=$(grep -nE '\bcsm\b|csm_' "$f" 2>/dev/null | grep -v '\.config/csm' || true)
  [[ -n "$hits" ]] && { note "WARNING: $f references 'csm' outside the managed import — update these after cutover (e.g. @csm_status → @claude0_status):"; printf '%s\n' "$hits"; }
done
# Anything still working inside the old repo path loses its cwd at the mv.
live=""
for l in /proc/[0-9]*/cwd; do
  t=$(readlink "$l" 2>/dev/null || true)
  [[ "$t" == "$OLD_REPO"* ]] && live+="${l#/proc/}"$'\n'
done
live=$(printf '%s' "$live" | cut -d/ -f1 | sort -un | tr '\n' ' ')
if [[ -n "${live// /}" ]]; then
  note "WARNING: live processes with cwd under $OLD_REPO (pids): $live"
  read -r -p "  Continue anyway? [y/N] " a
  [[ "$a" == y* ]] || exit 1
fi

# ── 2. Backup ──────────────────────────────────────────────────────────────────
if [[ -d "$OLD_CFG" && ! -f "$BACKUP" ]]; then
  step "backup $OLD_CFG → $BACKUP"
  tar czf "$BACKUP" -C "$HOME/.config" csm
else
  note "backup present or old config dir already moved — skipping"
fi

# ── 3. Stop old units, move the state dir ──────────────────────────────────────
step "retire csm-* units, move state dir"
for u in "${OLD_UNITS[@]}"; do
  systemctl --user stop "$u" 2>/dev/null || true
  systemctl --user disable "$u" 2>/dev/null || true
  rm -f "$UNIT_DIR/$u"
done
if [[ -d "$OLD_CFG" && ! -d "$NEW_CFG" ]]; then
  mv "$OLD_CFG" "$NEW_CFG"
fi
[[ -d "$NEW_CFG" ]] || die "$NEW_CFG missing after move"
[[ -f "$NEW_CFG/bridge.env" ]] && sed -i 's/^CSM_BRIDGE_/CLAUDE0_BRIDGE_/' "$NEW_CFG/bridge.env"

# ── 4. Rename the repo, heal git state ─────────────────────────────────────────
step "rename repo, repair worktrees, point remote at claude0"
if [[ -d "$OLD_REPO" && ! -d "$NEW_REPO" ]]; then
  mv "$OLD_REPO" "$NEW_REPO"
fi
[[ -d "$NEW_REPO" ]] || die "$NEW_REPO missing after move"
# git records absolute paths on both sides of a worktree link; repair from the
# base AND from each worktree so both directions heal.
git -C "$NEW_REPO" worktree repair 2>/dev/null || true
for wt in "$NEW_REPO"/.claude/worktrees/*/; do
  [[ -d "$wt" ]] && git -C "$wt" worktree repair 2>/dev/null || true
done
git -C "$NEW_REPO" remote set-url origin git@github.com:marcelmiro/claude0.git

# ── 5. Backfill recorded paths ─────────────────────────────────────────────────
step "backfill recorded paths"
for f in "$NEW_CFG/resurrect-sessions.json" "$NEW_CFG"/panes/*; do
  [[ -f "$f" ]] && sed -i "s#$OLD_REPO#$NEW_REPO#g" "$f"
done
# The priority list may pin this repo by its old name. Scoped with jq — a
# blanket sed would rewrite any other string field that happens to be "csm".
# The `// null` keeps the condition total: without it, a non-object
# .repositories makes `.priority?` the empty stream and the whole filter emits
# NOTHING with exit 0 — the mv would then install a 0-byte config. With it,
# a non-array/absent priority takes the else-branch identity instead of the
# empty stream; a real jq failure exits non-zero and set -e aborts before the mv.
if [[ -f "$NEW_CFG/config.json" ]]; then
  jq 'if ((.repositories.priority? // null) | type) == "array"
      then .repositories.priority |= map(if . == "csm" then "claude0" else . end)
      else . end' \
    "$NEW_CFG/config.json" > "$NEW_CFG/config.json.tmp"
  [[ -s "$NEW_CFG/config.json.tmp" ]] || die "config.json rewrite produced empty output — config.json left untouched"
  mv "$NEW_CFG/config.json.tmp" "$NEW_CFG/config.json"
fi
# inbox.db snapshot rows carry absolute repoPath. Live rows self-heal at the
# next discovery tick, but pane-less parked/done rows are fact-preserved and
# would resume into the dead path — rewrite in place while units are stopped.
if [[ -f "$NEW_CFG/inbox.db" ]]; then
  (cd "$NEW_REPO" && bun -e '
    const { Database } = require("bun:sqlite");
    const db = new Database(process.env.HOME + "/.config/claude0/inbox.db");
    const rows = db.query("SELECT session_id, data FROM snapshot").all();
    const upd = db.prepare("UPDATE snapshot SET data = ? WHERE session_id = ?");
    let n = 0;
    for (const r of rows) {
      const next = r.data.replaceAll(process.env.HOME + "/dev/csm", process.env.HOME + "/dev/claude0");
      if (next !== r.data) { upd.run(next, r.session_id); n++; }
    }
    console.log("  rewrote " + n + " snapshot rows");
    db.close();
  ')
fi
# Retire the pre-rebrand command surface: the csm symlink (only when it points
# at this project's entry script) and the long-retired csm-terminal launcher.
for link in "$HOME/.local/bin/csm" "$HOME/.bun/bin/csm"; do
  if [[ -L "$link" ]] && [[ "$(readlink "$link")" == */bin/csm.ts ]]; then rm -f "$link"; fi
done
rm -f "$HOME/.local/bin/csm-terminal"
# Drop the pre-rebrand dotfile import lines (exact known strings that only the
# old setup ever wrote — `claude0 setup` will append the new ones).
for f in "$HOME/.tmux.conf" "$HOME/.zshrc"; do
  [[ -f "$f" ]] || continue
  sed -i \
    -e "\%^if-shell 'test -f ~/.config/csm/tmux.conf' 'source-file ~/.config/csm/tmux.conf' ''$%d" \
    -e '\%^\[\[ -r "$HOME/.config/csm/shell.zsh" \]\] && source "$HOME/.config/csm/shell.zsh"$%d' \
    -e '/^# CSM integration (managed by csm setup)$/d' "$f"
done
# Deregister the pre-rebrand Claude hooks — their scripts rode the state-dir
# move, and `claude0 setup` registers the ~/.config/claude0 set fresh.
SETTINGS="$HOME/.claude/settings.json"
if [[ -f "$SETTINGS" ]]; then
  # Keep the FIRST run's backup — a resume must not overwrite the true
  # pre-rebrand settings with an already-stripped copy.
  [[ -f "$SETTINGS.pre-rebrand.bak" ]] || cp "$SETTINGS" "$SETTINGS.pre-rebrand.bak"
  jq 'if (.hooks? // null | type) == "object"
      then .hooks |= with_entries(
        .value |= map(select((.hooks // [] | map(.command // "") | any(contains("/.config/csm/hooks/"))) | not))
        | select(.value | length > 0))
      else . end' \
    "$SETTINGS" > "$SETTINGS.tmp"
  [[ -s "$SETTINGS.tmp" ]] || die "settings.json hook rewrite produced empty output"
  mv "$SETTINGS.tmp" "$SETTINGS"
fi
# Reset per-device push state: the rebrand renames the client's device-id
# storage key, so every phone mints a fresh id and resubscribes on next PWA
# launch — old-id subscriptions would double-notify on broadcasts. The VAPID
# keypair stays (resubscription happens against it).
rm -f "$NEW_CFG/push-subscriptions.json"
rm -rf "$NEW_CFG/consumers" "$NEW_CFG/source" "$NEW_CFG/pushed"
# Best-effort: keep Claude Code transcripts + memory attached to the renamed
# repo (project dirs are keyed by the cwd path, dashes for slashes).
shopt -s nullglob
for d in "$HOME/.claude/projects/"*-dev-csm*; do
  target="${d/-dev-csm/-dev-claude0}"
  if [[ -e "$target" ]]; then
    note "WARNING: $target already exists — leaving $d in place"
  else
    mv "$d" "$target" || note "WARNING: could not rename $d"
  fi
done
shopt -u nullglob

# ── 6. Reinstall integration + units ───────────────────────────────────────────
step "bun install + claude0 setup + claude0-* units"
(cd "$NEW_REPO" && bun install)
(cd "$NEW_REPO" && bun run bin/claude0.ts setup)
for u in "${NEW_UNITS[@]}" tmux.service snapshot-check.service snapshot-check.timer; do
  [[ -f "$NEW_REPO/deploy/units/$u" ]] && cp "$NEW_REPO/deploy/units/$u" "$UNIT_DIR/$u"
done
# claude0-bridge/daemon ExecStart %h/.bun/bin/claude0 absolutely (systemd does not
# PATH-resolve); provision created the old csm link there — swap it.
mkdir -p "$HOME/.bun/bin"
ln -sf "$NEW_REPO/bin/claude0.ts" "$HOME/.bun/bin/claude0"
[[ -L "$HOME/.bun/bin/csm" ]] && rm -f "$HOME/.bun/bin/csm"
systemctl --user daemon-reload
for u in "${NEW_UNITS[@]}"; do
  systemctl --user enable --now "$u"
done

# ── 7. Verify ──────────────────────────────────────────────────────────────────
step "verify"
sleep 2
fail=0
for u in "${NEW_UNITS[@]}"; do
  if [[ "$(systemctl --user is-active "$u" || true)" == active ]]; then
    note "✓ $u active"
  else
    note "✗ $u NOT active — journalctl --user -u $u"
    fail=1
  fi
done
tok=$(grep '^CLAUDE0_BRIDGE_TOKEN=' "$NEW_CFG/bridge.env" 2>/dev/null | cut -d= -f2- || true)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8473/auth \
  -H 'content-type: application/json' -d "{\"token\":\"$tok\"}" || true)
if [[ "$code" == 200 ]]; then note "✓ bridge /auth → 200"; else note "✗ bridge /auth → $code"; fail=1; fi
if "$HOME/.local/bin/claude0" list >/dev/null 2>&1; then note "✓ claude0 list"; else note "✗ claude0 list failed"; fail=1; fi
[[ $fail == 0 ]] || die "verification failed — fix the ✗ items and re-run (idempotent), or restore from $BACKUP"
step "cutover complete — if not done yet, rename the GitHub repo to 'claude0' (Settings → General)"
