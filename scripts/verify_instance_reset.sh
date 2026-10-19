#!/usr/bin/env bash
# Verify `flow instance reset` on all vectors, most importantly that it is
# SURGICAL — it never disturbs a bystander instance. Launches a TARGET and a
# BYSTANDER, exercises the reset, and asserts target-fresh + bystander-intact.
#
# Usage:  scripts/verify_instance_reset.sh [TARGET] [BYSTANDER]
#   defaults: TARGET=qa-verify  BYSTANDER=dev-1  (reuses dev-1 if already up)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

TARGET="${1:-qa-verify}"
BYST="${2:-dev-1}"
FLOW_HOME_DIR="${FLOW_HOME:-$HOME/.flow}"
pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

port_of(){ grep -E '^LOCAL_SERVER_PORT=' ".env.$1.local" 2>/dev/null | cut -d= -f2; }
health(){ curl -s -m5 "http://localhost:$1/api/v1/graph/bootstrap" -o /dev/null -w '%{http_code}' 2>/dev/null; }
pid_of(){ python3 -c "import json;print(json.load(open('$FLOW_HOME_DIR/instances/$1/launcher.json')).get('backend_pid',''))" 2>/dev/null; }

echo "== setup: launch BYSTANDER=$BYST and TARGET=$TARGET =="
# `is-up` instead of grepping `status` for "UP": the old text form reported a
# port that merely had *a* listener, so a stale registry sharing a recycled port
# could make a dead bystander look alive and skip the launch below. `is-up`
# exits 0 only when every role is live AND ownership-verified.
uv run flow instance ctl is-up "$BYST" 2>/dev/null || scripts/instance_ctl.sh launch "$BYST" >/dev/null 2>&1
scripts/instance_ctl.sh launch "$TARGET" >/dev/null 2>&1
sleep 2
B_PORT=$(port_of "$BYST"); B_PID=$(pid_of "$BYST"); T_PORT=$(port_of "$TARGET")
echo "  bystander $BYST be=$B_PORT pid=$B_PID health=$(health "$B_PORT"); target $TARGET be=$T_PORT health=$(health "$T_PORT")"

echo "== V1/V2 kill+wipe (no-relaunch) =="
uv run flow instance reset "$TARGET" --no-relaunch --keep-keychain >/dev/null 2>&1
[ ! -d "$FLOW_HOME_DIR/instances/$TARGET" ] && ok "target dir wiped" || no "target dir remains"
[ ! -f ".env.$TARGET.local" ] && ok "target .env wiped" || no "target .env remains"
[ "$(health "$T_PORT")" = "000" ] && ok "target backend down" || no "target still serving"

echo "== V3 ISOLATION (bystander must be intact) =="
[ "$(health "$B_PORT")" = "200" ] && ok "bystander backend still 200" || no "bystander health changed"
ps -p "$B_PID" >/dev/null 2>&1 && ok "bystander backend pid alive" || no "bystander pid died"
[ -d "$FLOW_HOME_DIR/instances/$BYST" ] && ok "bystander dir intact" || no "bystander dir gone"
[ -f ".env.$BYST.local" ] && ok "bystander .env intact" || no "bystander .env gone"
[ -d "$FLOW_HOME_DIR/global" ] && ok "flow_home/global untouched" || no "flow_home/global gone"

echo "== V4 frozen-zombie recovery (stale lock+pid) + V6 readiness =="
mkdir -p "$FLOW_HOME_DIR/instances/$TARGET"; echo 99999 > "$FLOW_HOME_DIR/instances/$TARGET/server.pid"; : > "$FLOW_HOME_DIR/instances/$TARGET/server.lock"
OUT=$(uv run flow instance reset "$TARGET" --keep-keychain --json 2>&1 | tail -1)
echo "$OUT" | grep -q '"ready": true' && ok "reset-from-stale-lock ready" || no "reset not ready ($OUT)"
[ "$(grep -c 'already running' "$FLOW_HOME_DIR/instances/$TARGET/launcher-backend.log" 2>/dev/null)" = "0" ] && ok "no singleton bounce" || no "singleton bounce occurred"
VM=$(python3 -c "import json;print(json.load(open('$FLOW_HOME_DIR/instances/$TARGET/preferences.json'))['preferences.ui.view_mode'])" 2>/dev/null)
[ "$VM" = "standard" ] && ok "view_mode=standard applied" || no "view_mode=$VM"

echo "== V5 idempotency (reset again while up; reset when down) =="
uv run flow instance reset "$TARGET" --backend-only --json 2>&1 | tail -1 | grep -q '"ready": true' && ok "backend-only reset ok" || no "backend-only failed"
uv run flow instance reset "$TARGET" --no-relaunch --keep-keychain >/dev/null 2>&1
uv run flow instance reset "$TARGET" --keep-keychain --json 2>&1 | tail -1 | grep -q '"ready": true' && ok "reset-from-down ok" || no "reset-from-down failed"

echo "== V7 timing =="
uv run flow instance reset "$TARGET" --keep-keychain --json 2>&1 | tail -1 | python3 -c "import sys,json;print('  full reset elapsed:',json.loads(sys.stdin.read())['elapsed_s'],'s')"
uv run flow instance reset "$TARGET" --backend-only --json 2>&1 | tail -1 | python3 -c "import sys,json;print('  backend-only elapsed:',json.loads(sys.stdin.read())['elapsed_s'],'s')"

echo "== final bystander re-check =="
[ "$(health "$B_PORT")" = "200" ] && ok "bystander still 200 at end" || no "bystander damaged during run"

echo "== teardown: kill target =="
scripts/instance_ctl.sh kill "$TARGET" >/dev/null 2>&1

echo
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
