#!/usr/bin/env bash
# Bring up containerized alice + bob backends, prove identity isolation,
# then run the realtime round-trip tests against them.
#
#   $ ./docker/run_realtime_tests.sh
#
# Prereqs:
#   - Docker Desktop running (or Docker Engine >= 20.10 on Linux)
#   - Hub backend running on host at http://localhost:8093 (run from
#     /Users/shlom/Documents/dev/test_flowpad/FlowPad)
#   - flowpad-app sibling repo at /Users/shlom/Documents/dev/flowpad-app
#     with its UI deps installed (for bob's vitest)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP_ROOT="/Users/shlom/Documents/dev/flowpad-app"
COMPOSE="docker compose -f docker/docker-compose.yml"

echo "==> [1/6] sanity: hub on host"
curl -sf http://localhost:8093/api/v1/health/status >/dev/null \
  || { echo "Hub not running on :8093"; exit 1; }
echo "    hub OK"

echo "==> [2/6] starting containers"
$COMPOSE up -d --build --wait
echo "    alice + bob healthy"

echo "==> [3/6] env-mode cloud login (both)"
curl -fsS -X POST http://localhost:9008/api/v1/cloud/login \
  -H 'Content-Type: application/json' -d '{}' >/dev/null
curl -fsS -X POST http://localhost:9007/api/v1/cloud/login \
  -H 'Content-Type: application/json' -d '{}' >/dev/null
sleep 1

echo "==> [4/6] identity sanity"
ALICE=$(curl -fsS http://localhost:9008/api/v1/cloud/status \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['user']['email'])")
BOB=$(curl -fsS http://localhost:9007/api/v1/cloud/status \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(d['user']['email'])")
echo "    alice=$ALICE  bob=$BOB"
if [ "$ALICE" != "alice@local.test" ] || [ "$BOB" != "bob@local.test" ]; then
  echo "    identity sanity FAILED — alice/bob must be distinct, expected emails"
  exit 1
fi
echo "    identities distinct"

echo "==> [5/6] pytest realtime tests (hub-direct)"
FLOWPAD_HUB_URL=http://localhost:8093 uv run pytest \
  tests/hub_tests/test_share_with_recipients.py \
  tests/hub_tests/test_two_client_loop.py -v

echo "==> [6/6] vitest two-process ping-pong"
echo "    starting bob's vitest (he polls for alice's invite)"
( cd "$APP_ROOT/ui" && npm run test:vitest:hub ) > /tmp/bob_vitest.log 2>&1 &
BOB_PID=$!
sleep 3
echo "    starting alice's vitest"
( cd "$ROOT/ui" && npm run test:vitest:hub )
wait $BOB_PID
echo "==> bob result:"
tail -20 /tmp/bob_vitest.log

echo
echo "ALL GREEN. Tear down with:  $COMPOSE down -v"
