#!/usr/bin/env bash
# Container script — orchestrates stages A-F.
# See plan: ~/.claude/plans/once-done-add-to-dreamy-aurora.md

set -euo pipefail

PINNED_OLD_VERSION="${PINNED_OLD_VERSION:-0.2.25}"
NEW_WHEEL_GLOB="/wheels/flowpad-*.whl"
PORT="${LOCAL_SERVER_PORT:-9711}"

banner() { echo; echo "============================================================"; echo "=== $*"; echo "============================================================"; }
fail()   { echo "FAIL: $*" >&2; exit 1; }

wait_for_health() {
    local timeout="${1:-30}"
    for i in $(seq 1 "$timeout"); do
        if curl -fsS "http://localhost:${PORT}/health/status" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

stop_server() {
    # `flow start service` detaches a monitor + server pair; kill both.
    pkill -f "flow_sdk.server.run" 2>/dev/null || true
    pkill -f "flow_sdk.server.monitor" 2>/dev/null || true
    sleep 2
    for _ in $(seq 1 10); do
        if ! curl -fsS "http://localhost:${PORT}/health/status" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

start_server_bg() {
    # `flow start service` is non-blocking — it spawns the detached server
    # and returns. We don't background the call itself.
    flow start service
    sleep 1
}

# -----------------------------------------------------------------------------
banner "STAGE A — install pinned old version (${PINNED_OLD_VERSION})"
# -----------------------------------------------------------------------------
pip install --quiet "flowpad==${PINNED_OLD_VERSION}"
installed_ver=$(pip show flowpad 2>/dev/null | awk '/^Version:/ {print $2}')
test "$installed_ver" = "$PINNED_OLD_VERSION" \
    || fail "expected flowpad==${PINNED_OLD_VERSION}, got '${installed_ver}'"
command -v flow >/dev/null || fail "flow binary missing after install"
echo "  ✓ flowpad ${PINNED_OLD_VERSION} installed"

# -----------------------------------------------------------------------------
banner "STAGE B-pre — start OLD server (seed step needs HTTP indexer)"
# -----------------------------------------------------------------------------
start_server_bg
if ! wait_for_health 60; then
    echo "----- OLD server logs (last 60 lines) -----"
    find "${HOME}/.flow" -name "*.log" -exec tail -30 {} \; 2>/dev/null | tail -60
    fail "OLD server did not become healthy in 60s"
fi
echo "  ✓ OLD server healthy on :${PORT}"

# -----------------------------------------------------------------------------
banner "STAGE B — seed assets on OLD version (server up, HTTP indexer reachable)"
# -----------------------------------------------------------------------------
python3 /test/seed_assets.py || fail "seed_assets.py failed"
test -f /tmp/seeded_ids.json || fail "seeded_ids.json not written"
echo "  ✓ seeded $(jq length /tmp/seeded_ids.json) records"

# -----------------------------------------------------------------------------
banner "STAGE C — baseline check on OLD version"
# -----------------------------------------------------------------------------
first_name=$(jq -r '.[0].name' /tmp/seeded_ids.json)
# Search by name — FTS5 tokenizes the human-readable name, not bare UUIDs.
resp=$(curl -fsS "http://localhost:${PORT}/api/v1/search?q=${first_name}&limit=1" || echo "")
if [ -n "$resp" ]; then
    found=$(jq -r '.data.total // (.data.results | length // 0)' <<<"$resp" 2>/dev/null || echo 0)
    echo "  ✓ OLD /api/v1/search finds seeded record (${first_name}): ${found} hit(s)"
else
    echo "  ! OLD /api/v1/search returned empty for ${first_name} — informational only"
fi

# -----------------------------------------------------------------------------
banner "STAGE D — stop OLD, upgrade to NEW wheel"
# -----------------------------------------------------------------------------
stop_server || fail "could not stop OLD server"
echo "  ✓ OLD server stopped"

NEW_WHEEL=$(ls $NEW_WHEEL_GLOB 2>/dev/null | head -n1)
test -n "$NEW_WHEEL" || fail "no wheel at ${NEW_WHEEL_GLOB} — did run.sh mount /wheels?"
pip install --quiet --upgrade --force-reinstall "$NEW_WHEEL"
new_ver=$(pip show flowpad 2>/dev/null | awk '/^Version:/ {print $2}')
test "$new_ver" = "0.2.26" \
    || fail "expected flowpad==0.2.26 after upgrade, got '${new_ver}'"
echo "  ✓ upgraded to $(basename "$NEW_WHEEL") (Version: ${new_ver})"

# -----------------------------------------------------------------------------
banner "STAGE E — flow start on NEW version triggers migration"
# -----------------------------------------------------------------------------
start_server_bg
if ! wait_for_health 90; then
    echo "----- NEW server logs (last 60 lines) -----"
    find "${HOME}/.flow" -name "*.log" -exec tail -30 {} \; 2>/dev/null | tail -60
    fail "NEW server did not become healthy in 90s"
fi
echo "  ✓ NEW server healthy on :${PORT}"

# -----------------------------------------------------------------------------
banner "STAGE F — verify migration outcomes"
# -----------------------------------------------------------------------------
if bash /test/verify_post_migration.sh; then
    banner "MIGRATION E2E (container side): PASS"
    echo "  Server still running on :${PORT} for browser validation."
else
    banner "MIGRATION E2E (container side): STAGE F FAILED"
    echo "  Dumping filesystem state for diagnosis:"
    echo "----- ${HOME}/.flow/dev_records (legacy) -----"
    find "${HOME}/.flow/dev_records" -maxdepth 3 -print 2>/dev/null | head -40 || true
    echo "----- ${HOME}/.flow/instances/dev/records (new) -----"
    find "${HOME}/.flow/instances/dev/records" -maxdepth 3 -print 2>/dev/null | head -40 || true
    echo "----- /tmp/seeded_ids.json -----"
    cat /tmp/seeded_ids.json 2>/dev/null || true
fi
echo "  Sleeping forever — host will docker kill."
sleep infinity
