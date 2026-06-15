#!/usr/bin/env bash
# Run the two-process hub protocol test pairs (alice ↔ bob over the local hub).
#
# These tests are EXCLUDED from `vitest --project hub` (see ui/vitest.config.ts):
# each is one half of a concurrent pair coordinated via a rendezvous file, so a
# sequential run can never pass them. This script launches both halves
# concurrently — alice against the default backend (.env.local), bob against a
# bob-logged-in instance (launched here via instance_ctl if missing).
#
# Pairs:
#   matrix.alice.test.ts                ↔ matrix.bob.test.ts
#   conversation_messages.test.ts       ↔ conversation_messages.bob.test.ts
#
# Requires: local hub up (FLOWPAD_HUB_URL), main backend cloud-logged-in.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.local; set +a
: "${FLOWPAD_HUB_URL:?FLOWPAD_HUB_URL must be set (no hardcoded hub URL)}"

BOB_INSTANCE="${BOB_INSTANCE:-bobqa}"
BOB_EMAIL="${BOB_EMAIL:-bob@local.test}"
BOB_PASSWORD="${BOB_PASSWORD:-${BOB_EMAIL%%@*}-pw-1234}"

status="$(scripts/instance_ctl.sh status "$BOB_INSTANCE" 2>/dev/null || true)"
if ! grep -q "backend :[0-9]* \[UP\]" <<<"$status"; then
  scripts/instance_ctl.sh launch "$BOB_INSTANCE" --email "$BOB_EMAIL" --password "$BOB_PASSWORD"
  status="$(scripts/instance_ctl.sh status "$BOB_INSTANCE")"
fi
BOB_BE="$(grep -oE 'backend :[0-9]+' <<<"$status" | grep -oE '[0-9]+' | head -1)"
echo "[paired] bob backend: :$BOB_BE ($BOB_INSTANCE)"

run_pair() { # <alice-file> <bob-file> <rendezvous-file>
  local alice="$1" bob="$2" rendezvous="$3" arc brc
  rm -f "$rendezvous"
  echo "[paired] running $alice ↔ $bob"
  (cd ui && FLOWPAD_HUB_URL="$FLOWPAD_HUB_URL" VITE_API_URL="http://localhost:$BOB_BE" \
    npx vitest run --project hub-paired "$bob") &
  local bpid=$!
  sleep 8  # let bob pre-warm before alice's protocol window opens
  (cd ui && FLOWPAD_HUB_URL="$FLOWPAD_HUB_URL" \
    npx vitest run --project hub-paired "$alice") &
  local apid=$!
  wait "$apid"; arc=$?
  wait "$bpid"; brc=$?
  echo "[paired] $(basename "$alice") rc=$arc | $(basename "$bob") rc=$brc"
  return $(( arc || brc ))
}

rc=0
run_pair tests/hub/matrix.alice.test.ts tests/hub/matrix.bob.test.ts /tmp/flowpad_matrix_conv.txt || rc=1
run_pair tests/hub/conversation_messages.test.ts tests/hub/conversation_messages.bob.test.ts /tmp/flowpad_pingpong_conv.txt || rc=1
exit $rc
