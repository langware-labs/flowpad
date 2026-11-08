#!/bin/bash
#
# Restart a Flowpad instance (`flow stop`, then `flow start`) in a session of its own.
#
# Why: a shell an agentic process or a Flowpad terminal opened is a CHILD of the server it would
# restart. `flow stop` takes that server down with its children, so a plain
# `flow stop; flow start` dies before the start runs — the server stays down and every open UI
# keeps reconnecting to nothing ("connection refused" on refresh). Here the stop and the start run
# in a new session (fork + setsid, stdin from /dev/null) that the stop cannot reach, and this
# script returns at once.
#
# Usage: scripts/restart_detached.sh [LOG]
#   FLOW            the flow binary (default: the uv-tool install)
#   FLOW_INSTANCE   the instance to restart (default: prod), passed through as is
#   LOG             where the stop/start output goes (default: $TMPDIR/flowpad-restart.log)
set -euo pipefail

FLOW="${FLOW:-$HOME/.local/share/uv/tools/flowpad/bin/flow}"
LOG="${1:-${TMPDIR:-/tmp}/flowpad-restart.log}"
[ -x "$FLOW" ] || { echo "no flow binary at $FLOW" >&2; exit 1; }

# A neutral cwd: run.py loads a repo's .env.local, which would hijack the instance and port.
cd "$HOME"
python3 -c '
import os, sys
if os.fork():
    sys.exit(0)
os.setsid()
os.execvp("sh", ["sh", "-c", sys.argv[1]])
' "\"$FLOW\" stop; echo \"stop exit=\$?\"; FLOWPAD_NO_BROWSER=1 \"$FLOW\" start; echo \"start exit=\$?\"" \
  < /dev/null > "$LOG" 2>&1
echo "restart detached; output in $LOG"
