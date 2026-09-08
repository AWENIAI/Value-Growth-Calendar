#!/usr/bin/env bash
set -euo pipefail

project_dir="$1"
commit_message="$2"
shift 2

cd "$project_dir"
git config user.name "AWEN Calendar Bot"
git config user.email "actions@aweniai.com"

current_branch="$(git branch --show-current)"
if [ -z "$current_branch" ]; then
  echo "Git sync error: not on a branch" >&2
  exit 1
fi

if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  echo "Git sync error: unresolved merge conflicts" >&2
  git diff --name-only --diff-filter=U >&2
  exit 1
fi

git add "$@"

if git diff --cached --quiet; then
  echo "Git sync: no tracked calendar changes to commit"
  exit 0
fi

git commit -m "$commit_message"

if ! git push origin "$current_branch"; then
  echo "Git sync error: push failed; local commit retained for recovery" >&2
  exit 1
fi

echo "Git sync: pushed to GitHub"
