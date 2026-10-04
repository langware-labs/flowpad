#!/usr/bin/env bash
# One real Chrome per Flowpad instance, driven through the chrome-devtools CLI
# (the CLI face of Chrome DevTools MCP). Every command prints what it did.
#
#   browser.sh start          launch the user's installed Chrome on the agent profile
#   browser.sh start --real   attach to the user's own running Chrome (consent flow)
#   browser.sh run <tool> …   run one chrome-devtools tool in this instance's session
#   browser.sh front          bring the agent's Chrome window to the front, by pid
#   browser.sh status         print mode, pid, port, session
#   browser.sh stop           end the session; closes Chrome only if this script launched it
set -euo pipefail

INSTANCE="${FLOW_INSTANCE:-prod}"
BASE="$HOME/.flow/instances/$INSTANCE/browser"
STATE="$BASE/state.env"
PROFILE="$BASE/profile"
mkdir -p "$BASE"

cli() {
  if command -v chrome-devtools >/dev/null 2>&1; then chrome-devtools "$@"
  else npx -y --package=chrome-devtools-mcp@latest chrome-devtools "$@"; fi
}

MODE="" CHROME_PID="" PORT="" SESSION=""
[ -f "$STATE" ] && . "$STATE"

save_state() {
  printf 'MODE=%s\nCHROME_PID=%s\nPORT=%s\nSESSION=%s\n' "$MODE" "$CHROME_PID" "$PORT" "$SESSION" >"$STATE"
}

new_session() { python3 -c 'import uuid; print(uuid.uuid4())'; }

find_chrome() {
  local c
  for c in "${CHROME_BIN:-}" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    google-chrome google-chrome-stable chromium chromium-browser; do
    [ -n "$c" ] || continue
    if [ -x "$c" ]; then echo "$c"; return 0; fi
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  return 1
}

# Chrome's own data dir — where --autoConnect looks for DevToolsActivePort.
user_chrome_dir() {
  case "$(uname -s)" in
    Darwin) echo "$HOME/Library/Application Support/Google/Chrome" ;;
    *) echo "${XDG_CONFIG_HOME:-$HOME/.config}/google-chrome" ;;
  esac
}

agent_chrome_alive() {
  [ -n "$CHROME_PID" ] && kill -0 "$CHROME_PID" 2>/dev/null &&
    curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null
}

# `chrome-devtools start` RESTARTS a running daemon, which would cut off another
# agent mid-call on the same session — so start only when none is running.
start_daemon() {
  if cli status --sessionId "$SESSION" 2>/dev/null | grep -q "is running"; then return 0; fi
  local out
  out=$(cli start "$@" --sessionId "$SESSION" --no-usage-statistics --no-performance-crux 2>&1) ||
    { echo "DAEMON_FAILED:" >&2; echo "$out" >&2; exit 6; }
}

start_agent() {
  if [ "$MODE" = agent ] && agent_chrome_alive; then
    echo "reusing agent Chrome pid=$CHROME_PID port=$PORT"
  else
    local chrome
    chrome=$(find_chrome) || { echo "NO_CHROME: install Google Chrome or set CHROME_BIN" >&2; exit 2; }
    PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
    nohup "$chrome" --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" \
      --no-first-run --no-default-browser-check about:blank >"$BASE/chrome.log" 2>&1 &
    CHROME_PID=$!
    for _ in $(seq 50); do
      curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null && break
      kill -0 "$CHROME_PID" 2>/dev/null || break
      sleep 0.2
    done
    if ! agent_chrome_alive; then
      echo "CHROME_DID_NOT_START: the agent profile may already be open in another Chrome process" >&2
      echo "  profile: $PROFILE" >&2
      tail -5 "$BASE/chrome.log" >&2
      exit 3
    fi
    echo "launched agent Chrome pid=$CHROME_PID port=$PORT profile=$PROFILE"
  fi
  MODE=agent
  [ -n "$SESSION" ] || SESSION=$(new_session)
  save_state
  start_daemon --browserUrl "http://127.0.0.1:$PORT"
  echo "session=$SESSION ready"
}

start_real() {
  local dir
  dir=$(user_chrome_dir)
  if [ ! -f "$dir/DevToolsActivePort" ]; then
    printf '%s' 'chrome://inspect/#remote-debugging' | pbcopy 2>/dev/null || true
    echo "NEEDS_USER: remote debugging is off in the user's Chrome." >&2
    echo "  Ask the user to: open their Chrome, paste chrome://inspect/#remote-debugging" >&2
    echo "  into the address bar (it is on the clipboard on macOS), turn remote debugging on," >&2
    echo "  then say so. Chrome will then show an Allow dialog for them to click." >&2
    exit 4
  fi
  MODE=real CHROME_PID="" PORT=""
  SESSION=$(new_session)
  save_state
  start_daemon --autoConnect
  echo "session=$SESSION attached to the user's Chrome (they must click Allow in Chrome)"
}

case "${1:-}" in
  start) shift; if [ "${1:-}" = --real ]; then start_real; else start_agent; fi ;;
  run)
    shift
    [ -n "$SESSION" ] || { echo "NOT_STARTED: run 'browser.sh start' first" >&2; exit 5; }
    cli "$@" --sessionId "$SESSION" ;;
  front)
    if [ "$MODE" = agent ] && agent_chrome_alive && [ "$(uname -s)" = Darwin ]; then
      osascript -l JavaScript -e "ObjC.import('AppKit'); \$.NSRunningApplication.runningApplicationWithProcessIdentifier($CHROME_PID).activateWithOptions(3)" >/dev/null
      echo "focus requested for agent Chrome pid=$CHROME_PID — macOS may keep a full-screen app in front; confirm with the user"
    else
      echo "nothing to bring forward (mode=${MODE:-none}); ask the user to switch to the window" >&2
    fi ;;
  status)
    echo "mode=${MODE:-none} chrome_pid=${CHROME_PID:-} port=${PORT:-} session=${SESSION:-}"
    [ -n "$SESSION" ] && cli status --sessionId "$SESSION" || true ;;
  stop)
    [ -n "$SESSION" ] && cli stop --sessionId "$SESSION" >/dev/null 2>&1 || true
    if [ "$MODE" = agent ] && [ -n "$CHROME_PID" ] && kill -0 "$CHROME_PID" 2>/dev/null; then
      kill "$CHROME_PID"; echo "closed agent Chrome pid=$CHROME_PID"
    fi
    rm -f "$STATE"; echo "stopped" ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
