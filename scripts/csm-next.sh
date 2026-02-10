#!/usr/bin/env bash
# CSM Quick-Action: jump to the most urgent session needing attention.
# Bind in tmux.conf: bind-key n run-shell "~/.config/csm/csm-next.sh"
# Or: bind-key n run-shell "/path/to/csm/scripts/csm-next.sh"

STATE_FILE="$HOME/.config/csm/state.json"

if [ ! -f "$STATE_FILE" ]; then
  tmux display-message "CSM: no state file"
  exit 0
fi

# Parse state.json to find most urgent attention session
# Priority: waiting (blocked) first, then ready (turnComplete)
BEST_SESSION=""
BEST_WINDOW=""
BEST_PANE=""
BEST_PRIORITY=99

# Use bun to parse JSON (available since CSM requires bun)
read -r BEST_SESSION BEST_WINDOW BEST_PANE < <(
  bun -e "
    const state = JSON.parse(require('fs').readFileSync('$STATE_FILE', 'utf8'));
    let best = null;
    let bestPriority = 99;
    for (const [key, s] of Object.entries(state.sessions)) {
      if (!s.needsAttention) continue;
      const priority = s.attentionType === 'blocked' ? 0 : 1;
      if (priority < bestPriority) {
        bestPriority = priority;
        best = s;
      }
    }
    if (best) {
      console.log(best.tmuxSession + ' ' + best.tmuxWindow + ' ' + best.tmuxPane);
    }
  " 2>/dev/null
)

if [ -z "$BEST_SESSION" ]; then
  tmux display-message "CSM: no sessions need attention"
  exit 0
fi

# Switch to the session
tmux select-window -t "${BEST_SESSION}:${BEST_WINDOW}" 2>/dev/null
tmux select-pane -t "${BEST_PANE}" 2>/dev/null

# Clear the ⚡ prefix from the window name
CURRENT_NAME=$(tmux display-message -t "${BEST_SESSION}:${BEST_WINDOW}" -p '#{window_name}' 2>/dev/null)
if [[ "$CURRENT_NAME" == ⚡* ]]; then
  CLEAN_NAME="${CURRENT_NAME#⚡}"
  tmux rename-window -t "${BEST_SESSION}:${BEST_WINDOW}" "$CLEAN_NAME" 2>/dev/null
fi
