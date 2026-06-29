#!/usr/bin/env bash
# Verifies the machine_id cache-survival contract inside a Linux container.
# Stages M1-M8 from the implementation plan.

set -euo pipefail

NEW_WHEEL_GLOB="/wheels/flowpad-*.whl"
CACHE="${HOME}/.flow/global/system.json"

banner() { echo; echo "============================================================"; echo "=== $*"; echo "============================================================"; }
fail()   { echo "FAIL: $*" >&2; exit 1; }
ok()     { echo "  ✓ $*"; }

# Helper — call get_machine_id() once and print the value.
mid() {
    python3 -c "from flow_sdk.utils.machine_id import get_machine_id; print(get_machine_id())"
}

banner "Install wheel"
NEW_WHEEL=$(ls $NEW_WHEEL_GLOB 2>/dev/null | head -n1)
test -n "$NEW_WHEEL" || fail "no wheel at ${NEW_WHEEL_GLOB} (mount /wheels)"
pip install --quiet "$NEW_WHEEL"
ok "installed $(basename "$NEW_WHEEL")"

# -----------------------------------------------------------------------------
banner "M1 — first call derives and writes cache"
# -----------------------------------------------------------------------------
test ! -f "$CACHE" || fail "cache exists pre-test — start fresh"
V1=$(mid)
test -n "$V1" || fail "got empty machine_id"
test -f "$CACHE" || fail "cache not written at $CACHE"
PROV=$(jq -r '._provenance' "$CACHE")
test "$PROV" = "linux:/etc/machine-id" \
    || fail "expected provenance linux:/etc/machine-id, got '$PROV'"
ok "M1: derived V1=${V1:0:16}... provenance=$PROV"

# -----------------------------------------------------------------------------
banner "M2 — second call returns cached value (same process flavor)"
# -----------------------------------------------------------------------------
V2=$(mid)
test "$V1" = "$V2" || fail "M2: expected $V1, got $V2"
ok "M2: cache hit"

# -----------------------------------------------------------------------------
banner "M3 — fresh subprocess returns IDENTICAL value (file cache)"
# -----------------------------------------------------------------------------
V3=$(mid)
test "$V1" = "$V3" || fail "M3: expected $V1, got $V3"
ok "M3: file cache survives process restart"

# -----------------------------------------------------------------------------
banner "M4 — FLOW_INSTANCE switch returns same value (cache is in global/)"
# -----------------------------------------------------------------------------
V4_DEV=$(FLOW_INSTANCE=dev mid)
V4_PROD=$(FLOW_INSTANCE=prod mid)
test "$V1" = "$V4_DEV"  || fail "M4: dev got $V4_DEV, expected $V1"
test "$V1" = "$V4_PROD" || fail "M4: prod got $V4_PROD, expected $V1"
ok "M4: cross-instance shared"

# -----------------------------------------------------------------------------
banner "M5 — delete /etc/machine-id, cache still wins"
# -----------------------------------------------------------------------------
# Save it (we'll restore for clarity even though we don't strictly need to)
ORIG_MID=$(cat /etc/machine-id)
rm -f /etc/machine-id
# Also remove the dbus fallback so derivation is FORCED to fail if cache is bypassed
rm -f /var/lib/dbus/machine-id 2>/dev/null || true
V5=$(mid)
test "$V1" = "$V5" || fail "M5: cache should win after /etc/machine-id deleted; got $V5"
ok "M5: cached value survives OS-id deletion"

# -----------------------------------------------------------------------------
banner "M6 — delete cache, re-derive (must equal V1 since /etc/machine-id still gone → fallback)"
# -----------------------------------------------------------------------------
# Restore /etc/machine-id so derivation gives the SAME value as M1
echo "$ORIG_MID" > /etc/machine-id
rm -f "$CACHE"
V6=$(mid)
test "$V1" = "$V6" || fail "M6: re-derivation should match V1; got $V6 vs V1=$V1"
test -f "$CACHE" || fail "M6: cache should be recreated"
ok "M6: re-derived from /etc/machine-id, deterministic"

# -----------------------------------------------------------------------------
banner "M7 — delete BOTH cache AND /etc/machine-id → fallback path"
# -----------------------------------------------------------------------------
rm -f "$CACHE" /etc/machine-id /var/lib/dbus/machine-id
V7A=$(mid 2>&1 | grep -v "machine_id:" | tail -1)
test "${V7A:0:9}" = "fallback-" \
    || fail "M7: expected 'fallback-...' prefix; got '$V7A'"
# Second call: should now hit cache (fallback value persisted)
V7B=$(mid)
test "$V7A" = "$V7B" || fail "M7: fallback should be cached; got V7A=$V7A V7B=$V7B"
ok "M7: fallback path used + cached"

# Restore so the rest of the test runs cleanly
echo "$ORIG_MID" > /etc/machine-id

# -----------------------------------------------------------------------------
banner "M8 — concurrent first-write: 10 subprocesses on fresh install converge"
# -----------------------------------------------------------------------------
rm -f "$CACHE"
# Run 10 in parallel, collect their outputs
TMP=$(mktemp -d)
for i in $(seq 1 10); do
    ( mid > "$TMP/out.$i" ) &
done
wait
# All must have produced the same value
EXPECTED=$(cat "$TMP/out.1")
test -n "$EXPECTED" || fail "M8: first subprocess gave empty output"
for i in $(seq 2 10); do
    got=$(cat "$TMP/out.$i")
    test "$got" = "$EXPECTED" \
        || fail "M8: subprocess $i diverged: got '$got' expected '$EXPECTED'"
done
# Only one cache file exists (no race-corrupted siblings)
extras=$(ls "${HOME}/.flow/global"/*.json 2>/dev/null | wc -l)
test "$extras" -eq 1 || fail "M8: expected exactly 1 json under global/, got $extras"
rm -rf "$TMP"
ok "M8: 10 concurrent writers converged on a single cached value"

banner "MACHINE_ID DOCKER E2E: PASS"
echo "  Final machine_id: $V1"
