#!/bin/bash
cd /opt/Value-Growth-Calendar-worbuddy
export PYTHON_BIN=/home/ubuntu/venv_ib/bin/python
export NAV_MODE=1
/usr/bin/node worbuddy/sync.mjs
git -c core.hooksPath=/dev/null add docs/feed worbuddy/forward worbuddy/fetch_nav.py worbuddy/sync.mjs
git -c core.hooksPath=/dev/null commit -m "nav sync $(date +\%F\ %T)" || echo "no changes to commit"
git -c core.hooksPath=/dev/null push origin HEAD
