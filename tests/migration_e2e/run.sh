#!/usr/bin/env bash
# Host driver for the Docker e2e migration test.
#
# Usage:
#   bash tests/migration_e2e/run.sh
#
# What it does:
#   1. Asserts _version.py == "0.2.26" (the version the test expects)
#   2. Builds the UI assets + wheel on the host
#   3. Builds the Docker image
#   4. Stops any prior container of the same name
#   5. Runs the container with port 9711 → 9711
#   6. Waits for the container's stages A-F to finish (then it sleeps)
#   7. (Optional) Invokes browser_validate.py for Phase 4
#   8. Stops + removes the container; surfaces logs on failure
#
# Exit 0 = full pipeline passed. Exit non-zero = some stage failed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TESTS_DIR="${REPO_ROOT}/tests/migration_e2e"
IMAGE_NAME="flowpad-migration-e2e"
CONTAINER_NAME="flowpad-e2e"
PORT="${PORT:-9711}"

cd "$REPO_ROOT"

banner() { echo; echo "############################################################"; echo "## $*"; echo "############################################################"; }
fail()   { echo "FAIL: $*" >&2; cleanup_on_failure; exit 1; }

cleanup_on_failure() {
    if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        echo "## Dumping last 200 lines of container logs:" >&2
        docker logs --tail 200 "$CONTAINER_NAME" 2>&1 | sed 's/^/  /' >&2 || true
        docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi
}

cleanup_on_success() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}

# -----------------------------------------------------------------------------
banner "PRECHECK"
# -----------------------------------------------------------------------------
# 1. Version bump landed?
ver=$(python3 -c "import sys; sys.path.insert(0, '${REPO_ROOT}'); from flow_sdk._version import __version__; print(__version__)")
if [ "$ver" != "0.2.26" ]; then
    fail "flow_sdk/_version.py is '$ver' — expected '0.2.26'. Bump first."
fi
echo "  ✓ _version.py == 0.2.26"

# 2. Required tools
command -v docker >/dev/null || fail "docker not found"
command -v node   >/dev/null || fail "node not found (needed for build_ui.py)"
command -v uv     >/dev/null || fail "uv not found"
echo "  ✓ docker / node / uv present"

# 3. Port free?
if lsof -iTCP:${PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port ${PORT} already in use on host — pick a different one via PORT env"
fi
echo "  ✓ port ${PORT} free"

# -----------------------------------------------------------------------------
banner "BUILD WHEEL (host-side, needs node + uv)"
# -----------------------------------------------------------------------------
rm -rf "${REPO_ROOT}/dist"
python3 build_ui.py
uv build --wheel
wheel=$(ls "${REPO_ROOT}/dist"/flowpad-*.whl 2>/dev/null | head -n1)
test -n "$wheel" || fail "no wheel produced under ${REPO_ROOT}/dist/"
echo "  ✓ built $(basename "$wheel")"

# -----------------------------------------------------------------------------
banner "BUILD DOCKER IMAGE"
# -----------------------------------------------------------------------------
docker build -t "$IMAGE_NAME" -f "${TESTS_DIR}/Dockerfile" "${TESTS_DIR}"
echo "  ✓ image '${IMAGE_NAME}' built"

# -----------------------------------------------------------------------------
banner "RUN CONTAINER (stages A-F)"
# -----------------------------------------------------------------------------
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \
    --name "$CONTAINER_NAME" \
    -p "${PORT}:9711" \
    -v "${REPO_ROOT}/dist:/wheels:ro" \
    "$IMAGE_NAME" >/dev/null
echo "  container '${CONTAINER_NAME}' started"

# Tail the container's logs in the background so the user sees progress.
docker logs -f "$CONTAINER_NAME" &
LOG_PID=$!

# Wait for the in_container.sh banner indicating Stage F passed.
# Stage F finishes with the message "MIGRATION E2E (container side): PASS".
# We poll the logs for that marker.
start=$(date +%s)
PASS_MARKER="MIGRATION E2E (container side): PASS"
while true; do
    if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "$PASS_MARKER"; then
        break
    fi
    if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "^FAIL:"; then
        kill $LOG_PID 2>/dev/null || true
        fail "container reported FAIL — see logs above"
    fi
    if ! docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
        kill $LOG_PID 2>/dev/null || true
        fail "container exited unexpectedly"
    fi
    now=$(date +%s)
    if [ $((now - start)) -gt 300 ]; then
        kill $LOG_PID 2>/dev/null || true
        fail "container did not reach Stage F PASS within 5 minutes"
    fi
    sleep 2
done
kill $LOG_PID 2>/dev/null || true
echo
echo "  ✓ Stages A-F passed inside container"
echo "  ✓ Server still running on http://localhost:${PORT}"

# -----------------------------------------------------------------------------
banner "PHASE 4 — browser validation (optional)"
# -----------------------------------------------------------------------------
if [ -n "${SKIP_BROWSER:-}" ]; then
    echo "  SKIP_BROWSER set — skipping debugMCP browser checks"
else
    echo "  To run browser validation:"
    echo "    PORT=${PORT} python3 ${TESTS_DIR}/browser_validate.py"
    echo "  (must run inside a Claude Code session with debugMCP available)"
fi

# -----------------------------------------------------------------------------
banner "MIGRATION E2E: PASS"
# -----------------------------------------------------------------------------
cleanup_on_success
echo "Container removed. To inspect post-run, re-run without cleanup."
exit 0
