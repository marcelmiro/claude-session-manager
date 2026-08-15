#!/bin/bash
# CSM_HOOK_VERSION=__CSM_HOOK_VERSION__
# SubagentStop hook: Claude Code never fires WorktreeRemove for worktrees a
# WorktreeCreate hook created (verified: stock subagent worktrees are
# auto-removed, hook-created ones leak), so clean up a finished subagent's
# isolation worktree here. Mirrors stock semantics: remove only if unchanged
# (clean tree, no commits of its own); anything else stays on disk.
set -euo pipefail

IN=$(cat)
ID=$(jq -r '.agent_id // empty' <<<"$IN")
CWD=$(jq -r '.cwd // empty' <<<"$IN")
[ -n "$ID" ] && [ -n "$CWD" ] || exit 0

COMMON=$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
BASE=$(dirname "$COMMON")
REPO=$(basename "$BASE")
DIR="$(dirname "$BASE")/$REPO-agent-$ID"

# Not a worktree-isolated subagent (or already gone).
[ -d "$DIR" ] || exit 0

# Unchanged = clean tree and a tip already reachable from the base repo's
# HEAD (the branch forked off it and added nothing).
TIP=$(git -C "$DIR" rev-parse HEAD)
if [ -z "$(git -C "$DIR" status --porcelain)" ] \
   && git -C "$BASE" merge-base --is-ancestor "$TIP" HEAD; then
  git -C "$BASE" worktree remove "$DIR" >&2
  git -C "$BASE" branch -d "agent-$ID" >&2 || true
fi
exit 0
