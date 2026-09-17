#!/usr/bin/env bash
# Watch the course-sharing journey happen, and keep the evidence.
#
#   Alice shares a git-backed course project → Bob is offered it → Bob clicks
#   Install → the project opens straight into its auto-launching agent.
#
# This is the SAME journey as the hub test, run headed and screenshotted: one
# definition of "the journey", so the demo cannot drift from what is guarded.
#
#   scripts/course_share_live.sh [alice-instance] [bob-instance]
#
# Needs the local hub on :8093 (cd ../test_flowpad/FlowPad && uv run python flowpad/run.py).
# Screenshots land in artifacts/course-live-<stamp>/.
set -euo pipefail

ALICE_INST="${1:-dev-1}"
BOB_INST="${2:-dev-2}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_URL="${FLOWPAD_HUB_URL:-http://localhost:8093}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARTIFACTS="$REPO/artifacts/course-live-$STAMP"

cd "$REPO"
export PATH="$HOME/.nvm/versions/node/v22.15.0/bin:$PATH"

if [[ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$HUB_URL/api/v1/graph/bootstrap" || true)" != "200" ]]; then
  echo "The hub is not answering at $HUB_URL." >&2
  echo "Start it:  cd ../test_flowpad/FlowPad && env -u DEPLOY_ENV -u SOD_ENC_KEY uv run python flowpad/run.py" >&2
  exit 1
fi

for inst in "$ALICE_INST" "$BOB_INST"; do
  if ! scripts/instance_ctl.sh status "$inst" >/dev/null 2>&1; then
    echo "Launching $inst…"
    scripts/instance_ctl.sh launch "$inst"
  fi
done

# Each instance's own identity, read from the env file the launcher wrote —
# never assumed. An instance re-launched under a different user (it happens)
# would otherwise fail the tier's fail-closed identity gate with a confusing
# "no creds" instead of "wrong creds".
# (`mapfile` is bash 4; macOS ships 3.2, so read the two keys directly.)
creds_from() {
  local file="$REPO/.env.$1.local" key="$2"
  [[ -f "$file" ]] || { echo "missing $file — launch $1 first" >&2; exit 1; }
  grep -E "^FLOWPAD_CLOUD_USER_${key}=" "$file" | head -1 | sed 's/^[^=]*=//'
}
ALICE_EMAIL_V="$(creds_from "$ALICE_INST" EMAIL)"
ALICE_PW_V="$(creds_from "$ALICE_INST" PASSWORD)"
BOB_EMAIL_V="$(creds_from "$BOB_INST" EMAIL)"
BOB_PW_V="$(creds_from "$BOB_INST" PASSWORD)"

mkdir -p "$ARTIFACTS"
echo "Running the journey headed; screenshots → $ARTIFACTS"

cd ui
# `env -u LOCAL_SERVER_PORT`: a Flowpad shell exports the prod backend port, and
# it would out-rank the instance's own port in the hub config's env lookup.
status=0
env -u LOCAL_SERVER_PORT \
  FLOWPAD_HUB_URL="$HUB_URL" \
  SHARE_INST_1="$ALICE_INST" SHARE_INST_2="$BOB_INST" \
  ALICE_EMAIL="$ALICE_EMAIL_V" ALICE_PW="$ALICE_PW_V" \
  BOB_EMAIL="$BOB_EMAIL_V" BOB_PW="$BOB_PW_V" \
  FLOW_INSTANCE="$ALICE_INST" \
  FLOWPAD_TEST_HEADED=1 COURSE_LIVE_ARTIFACTS="$ARTIFACTS" \
  npx vitest run --project hub course_project_share || status=$?

echo
if [[ $status -eq 0 ]]; then
  echo "The journey ran end to end. Evidence:"
else
  echo "The journey FAILED (exit $status). What it captured before stopping:"
fi
ls -1 "$ARTIFACTS" 2>/dev/null | sed 's/^/  /' || echo "  (nothing captured)"
exit $status
