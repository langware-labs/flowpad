#!/usr/bin/env bash
# Restart the CI e2e backend on a fresh database and instance dir, then wait for bootstrap.
#
# Used by .github/actions/e2e-tests between suites. The new server inherits this shell's
# environment, so FLOWPAD_SKIP_FIRST_RUN_SETUP decides whether the first-run llm-setup
# trigger may fire on the next suite's first tab. Expects BACKEND_PID, SQLITE_DATABASE_PATH,
# FLOW_HOME and GITHUB_WORKSPACE, and appends the new BACKEND_PID to $GITHUB_ENV.
set -euo pipefail

kill "$BACKEND_PID" 2>/dev/null || true
for _ in $(seq 1 30); do kill -0 "$BACKEND_PID" 2>/dev/null || break; sleep 1; done
rm -f "$SQLITE_DATABASE_PATH"
rm -rf "$FLOW_HOME/instances/ci-e2e"
mkdir -p "$FLOW_HOME/instances/ci-e2e"
nohup .venv/bin/python -m flow_sdk.server.run >> backend.log 2>&1 &
NEW_PID=$!
echo "BACKEND_PID=$NEW_PID" >> "$GITHUB_ENV"
cat > "$FLOW_HOME/instances/ci-e2e/launcher.json" <<EOF
{
  "name": "ci-e2e",
  "backend_port": 6099,
  "env_file": "$GITHUB_WORKSPACE/.env.ci-e2e.local",
  "backend_pid": $NEW_PID
}
EOF
timeout=60   # seconds — do not raise; a slower boot is a bug to fix
elapsed=0
until curl -fsS http://localhost:6099/api/v1/graph/bootstrap | grep -q '"types"'; do
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "Backend did not come back within ${timeout}s."
    tail -50 backend.log || true
    exit 1
  fi
  sleep 1
  elapsed=$((elapsed+1))
done
echo "Backend reset (FLOWPAD_SKIP_FIRST_RUN_SETUP=${FLOWPAD_SKIP_FIRST_RUN_SETUP:-unset})."
