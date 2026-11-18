#!/usr/bin/env bash
# One-command real browser acceptance; only external model/worker boundaries are doubled.
set -euo pipefail

if [ "${1:-}" = --help ]; then
  echo 'Usage: bash scripts/test_message_tags_browser.sh [Playwright arguments]'
  echo 'Requires: uv, npm dependencies, Playwright Chromium, and a local test hub.'
  echo 'Creates a fresh isolated instance, retains evidence, stops only its own processes.'
  exit 0
fi

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export FLOWPAD_HUB_URL="${FLOWPAD_HUB_URL:-http://localhost:8093}"
(cd "$repo" && uv run python -c 'import os, sys; from urllib.parse import urlparse; u=urlparse(os.environ["FLOWPAD_HUB_URL"]); sys.exit(0 if u.scheme in {"http", "https"} and u.hostname in {"localhost", "127.0.0.1", "::1"} else "Message tags acceptance requires a loopback test hub; refusing external account creation.")')
run_dir="$(mktemp -d "${TMPDIR:-/tmp}/message-tags-acceptance.XXXXXX")"
instance="tags-rig-$$-73"
export FLOW_HOME="$run_dir/flow"
export FLOW_INSTANCE="$instance"
export FLOWPAD_INSTANCE_SKIP_GC=1
export FLOWPAD_INSTANCE_BACKEND_MODULE=tests.e2e.mock_worker_backend
export MOCK_MESSAGE_CLASSIFIER=1
export MOCK_DECISION=1
export MOCK_DECISION_MATCH=1
export MOCK_MESSAGE_TAG_CONTROL_PORT
MOCK_MESSAGE_TAG_CONTROL_PORT="$(cd "$repo" && uv run python -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"

cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ -f "$FLOW_HOME/instances/$instance/launcher.json" ]; then
    bash "$repo/scripts/instance_ctl.sh" kill "$instance" --keep-env >"$run_dir/cleanup.log" 2>&1 || true
  fi
  echo "Message tags evidence: $run_dir"
  exit "$result"
}
trap cleanup EXIT INT TERM

bash "$repo/scripts/instance_ctl.sh" launch "$instance" >"$run_dir/launch.log" 2>&1
set -a
source "$repo/.env.$instance.local"
set +a
cd "$repo/ui"
npx playwright test --config tests/manual_regression/automations/playwright.config.ts \
  message_tags tag_classifier --output "$run_dir/playwright" "$@"
