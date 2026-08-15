#!/bin/bash
# CSM_HOOK_VERSION=__CSM_HOOK_VERSION__
# WorktreeRemove hook: cleanup counterpart to worktree-create.sh. With a
# WorktreeCreate hook configured, Claude Code no longer removes worktrees
# itself. `git worktree remove` (no --force) refuses a dirty worktree, so
# work in progress is kept on disk; only clean worktrees are removed.
# Note: this event does NOT fire for subagent isolation worktrees —
# subagent-worktree-cleanup.sh (SubagentStop) covers those.
set -euo pipefail

WT=$(jq -r '.worktree_path // empty')
[ -n "$WT" ] && [ -d "$WT" ] || exit 0

git -C "$WT" worktree remove "$WT" >&2 || true
