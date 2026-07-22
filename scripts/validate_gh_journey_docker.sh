#!/usr/bin/env bash
# Clean-container validation for the GitHub setup journey (backend chain).
#
# Preconditions: the alice container is up (docker compose -f docker/docker-compose.yml
# up -d --wait alice) on a FRESH volume. Asserts, against a container with no gh
# and no GitHub credentials:
#   1. gh is absent in the container.
#   2. Both source_control capabilities report state "none" (never tried).
#   3. checkCapability semantics: unknown → journey gate OPEN → /launch yields a journal.
#   4. After installing gh in-container (unauthenticated), an explicit check flips
#      the row to installed/not-authenticated and state "not_available".
#   5. Journey advance s1→s2→s3 keeps working against the live journal.
#
# The OAuth approval and the device-code login need a human GitHub session —
# they stay manual (drive them from the UI at http://localhost:9008).
set -euo pipefail

BASE="http://localhost:9008/api/v1"
C=flowpad_alice
JOURNEY_ID="e485cbde-7d23-5a7f-aaf0-852ecdf754bb"
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# 1. clean container: no gh
docker exec "$C" which gh >/dev/null 2>&1 && fail "gh already present — not a clean container"
pass "container has no gh"

# 2. summary shows both kinds at state none
summary=$(curl -fsS "$BASE/graph/capabilities/summary")
for kind in source_control.github source_control.github.gh; do
  state=$(echo "$summary" | python3 -c "
import json,sys
d=json.load(sys.stdin)  # summary route returns the bare model (no envelope)
print(next(c['state'] for c in d['capabilities'] if c['kind']=='$kind'))")
  [ "$state" = "none" ] || fail "$kind state=$state (expected none)"
done
pass "both capabilities report state=none"

# 3. gate open → launch yields a journal
journal=$(curl -fsS -X POST "$BASE/journeys/$JOURNEY_ID/launch")
cursor=$(echo "$journal" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['cursor'])")
[ "$cursor" = "s1-connect" ] || fail "launch cursor=$cursor (expected s1-connect)"
pass "gate open — journey launched at s1-connect"

# 4. install gh in-container (Debian bookworm ships gh in its repos), then explicit check
docker exec "$C" bash -lc "apt-get update -qq && apt-get install -y -qq gh >/dev/null" \
  || fail "apt-get install gh failed"
cap_id=$(curl -fsS "$BASE/graph/capability?include_system=true" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['data']
print(next(r['id'] for r in rows if r.get('kind')=='source_control.github.gh'))")
check=$(curl -fsS -X POST "$BASE/graph/capability/$cap_id/check")
echo "$check" | python3 -c "
import json,sys
r=json.load(sys.stdin)['data']['result']
assert r['details'].get('installed') is True, r
assert r['details'].get('authenticated') is False, r
assert r['available'] is False, r
" || fail "post-install check wrong: $check"
state=$(curl -fsS "$BASE/graph/capability?include_system=true" | python3 -c "
import json,sys
rows=json.load(sys.stdin)['data']
print(next(r['state'] for r in rows if r.get('kind')=='source_control.github.gh'))")
[ "$state" = "not_available" ] || fail "gh state=$state (expected not_available after explicit check)"
pass "gh installed → explicit check → installed/not-authenticated, state=not_available"

# 5. journal advances (simulating the frontend's step completion calls)
for node in s1-connect s2-install-gh; do
  curl -fsS -X POST "$BASE/journeys/$JOURNEY_ID/advance" \
    -H 'Content-Type: application/json' -d "{\"node_id\": \"$node\"}" >/dev/null
done
cursor=$(curl -fsS "$BASE/journeys/$JOURNEY_ID/progress" | python3 -c "import json,sys; print(json.load(sys.stdin)['data']['cursor'])")
[ "$cursor" = "s3-login-gh" ] || fail "cursor=$cursor (expected s3-login-gh)"
pass "journey advanced to the gh login step"

echo
echo "Backend chain validated. Remaining MANUAL steps (need a human GitHub session):"
echo "  - open http://localhost:9008, launch the journey from Capabilities → Source Control"
echo "  - s1: Connect (OAuth) → approve in browser"
echo "  - s3: Log in → one-time code appears in the tray → approve at github.com/login/device"
echo "  - re-launch afterwards must be refused (gate closed)"
