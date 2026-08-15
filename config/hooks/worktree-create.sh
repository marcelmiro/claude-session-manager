#!/bin/bash
# CSM_HOOK_VERSION=__CSM_HOOK_VERSION__
# WorktreeCreate hook: create Claude Code worktrees as sibling directories
# ({parent}/{repo}-{name}) instead of the default {repo}/.claude/worktrees/{name}.
# Input (stdin): JSON with .name (worktree slug) and .cwd (session directory).
# Output: the worktree path as the last stdout line — Claude Code enters it.
# Everything else goes to stderr.
set -euo pipefail

INPUT=$(cat)
NAME=$(printf '%s' "$INPUT" | jq -r '.name // empty')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
[ -n "$NAME" ] && [ -n "$CWD" ] || { echo "worktree-create: missing name or cwd" >&2; exit 1; }

# Base repo root via the shared .git dir, so creating a worktree from inside
# another worktree still lands next to the base repo.
COMMON=$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir)
BASE=$(dirname "$COMMON")
REPO=$(basename "$BASE")

# Slashes would nest directories; flatten them for the dir name.
DIR="$(dirname "$BASE")/$REPO-${NAME//\//-}"

# Reusing an existing name opens the existing worktree.
if [ -d "$DIR" ]; then
  echo "worktree-create: reusing existing $DIR" >&2
  echo "$DIR"
  exit 0
fi

# Name matches an existing branch → put the worktree on that branch as-is
# (one branch, one PR — no fork). Otherwise create a new branch off HEAD.
# git refuses a branch already checked out in another worktree; let that
# error surface as a conflict instead of silently forking.
if git -C "$BASE" show-ref -q "refs/heads/$NAME"; then
  git -C "$BASE" worktree add "$DIR" "$NAME" >&2
else
  git -C "$BASE" worktree add -b "$NAME" "$DIR" >&2
fi
echo "$DIR"
