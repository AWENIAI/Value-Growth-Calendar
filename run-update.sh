#!/usr/bin/env bash
set -euo pipefail

cd /opt/Value-Growth-Calendar

if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  echo "Preflight error: unresolved Git conflicts" >&2
  exit 1
fi

git fetch origin main
git merge --ff-only origin/main

npm run update-strategy-a
npm run generate

/opt/Value-Growth-Calendar/ops/calendar-git-sync.sh /opt/Value-Growth-Calendar \
  "chore: auto-sync value growth calendar update" \
  data/strategy-a.json \
  data/strategy-a-state.json \
  docs/GLOBAL_KEY.ics \
  public/GLOBAL_KEY.ics \
  public/calendar/GLOBAL_KEY.ics \
  docs/feed/calendar.ics \
  docs/feed/signal.json \
  run-update.sh \
  ops/calendar-git-sync.sh \
  ops/value-growth-calendar.service \
  .githooks/pre-commit
