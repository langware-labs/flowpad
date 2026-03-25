#!/bin/bash
#
# Post-install smoke test for flowpad.
#
# Gates deployment — if this fails, the build is broken.
# Tests: CLI, server startup, health, UI serving, key imports.
#
# Usage:
#   ./scripts/validate_install.sh                    # test current env
#   ./scripts/validate_install.sh /path/to/python    # test specific python
#
# Exit code 0 = all good, non-zero = broken install.
#

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PYTHON="${1:-python3}"
FLOW="flow"

# If a custom python was given, derive flow from the same bin dir
if [[ "$1" ]]; then
    BIN_DIR="$(dirname "$PYTHON")"
    FLOW="${BIN_DIR}/flow"
fi

PASS=0
FAIL=0
WARN=0

check() {
    local label="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} $label"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}✗${NC} $label"
        FAIL=$((FAIL + 1))
    fi
}

check_output() {
    local label="$1"
    local expected="$2"
    shift 2
    local output
    output=$("$@" 2>&1) || true
    if echo "$output" | grep -qi "$expected"; then
        echo -e "  ${GREEN}✓${NC} $label"
        PASS=$((PASS + 1))
    else
        echo -e "  ${RED}✗${NC} $label (expected '$expected', got: $(echo "$output" | head -1))"
        FAIL=$((FAIL + 1))
    fi
}

warn_check() {
    local label="$1"
    shift
    if "$@" >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} $label"
        PASS=$((PASS + 1))
    else
        echo -e "  ${YELLOW}⚠${NC} $label (non-blocking)"
        WARN=$((WARN + 1))
    fi
}

echo -e "${YELLOW}=== flowpad install validation ===${NC}"
echo -e "Python: $PYTHON"
echo -e "Flow:   $FLOW"
echo ""

# =============================================
# CRITICAL — these MUST pass or deploy is blocked
# =============================================

echo -e "${YELLOW}1. Core imports${NC}"

check "import flow_sdk" \
    "$PYTHON" -c "import flow_sdk"

check "flow_sdk.__version__" \
    "$PYTHON" -c "import flow_sdk; assert flow_sdk.__version__, 'no version'"

check "import flow_sdk.server.app" \
    "$PYTHON" -c "import flow_sdk.server.app"

check "import flow_sdk.server.launch" \
    "$PYTHON" -c "import flow_sdk.server.launch"

check "import flow_sdk.cli.commands" \
    "$PYTHON" -c "import flow_sdk.cli.commands"

echo ""
echo -e "${YELLOW}2. CLI entry point${NC}"

check "flow --help" \
    "$FLOW" --help

echo ""
echo -e "${YELLOW}3. Server start & endpoints${NC}"

PORT=19007  # non-default to avoid conflicts
SERVER_PID=""

cleanup() {
    if [[ -n "$SERVER_PID" ]]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    lsof -ti :"$PORT" 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT

# Start server
MINIHUB_PORT=$PORT "$PYTHON" -m flow_sdk.server.run &
SERVER_PID=$!

echo -e "  Waiting for server on port $PORT..."
HEALTHY=false
for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:${PORT}/health/status" >/dev/null 2>&1; then
        HEALTHY=true
        break
    fi
    sleep 0.5
done

if $HEALTHY; then
    echo -e "  ${GREEN}✓${NC} Server started"
    PASS=$((PASS + 1))
else
    echo -e "  ${RED}✗${NC} Server failed to start within 15s"
    FAIL=$((FAIL + 1))
fi

if $HEALTHY; then
    check "GET /health/status" \
        curl -sf "http://127.0.0.1:${PORT}/health/status"

    check_output "GET / serves HTML" \
        "doctype html" \
        curl -s "http://127.0.0.1:${PORT}/"

    check "GET /favicon.ico" \
        curl -sf "http://127.0.0.1:${PORT}/favicon.ico"

    check "GET /logo.png" \
        curl -sf "http://127.0.0.1:${PORT}/logo.png"

    check "GET /api/v1/graph/bootstrap" \
        curl -sf "http://127.0.0.1:${PORT}/api/v1/graph/bootstrap"
fi

cleanup
SERVER_PID=""

echo ""

# =============================================
# NON-BLOCKING — warns about bare-import limitation
# =============================================

echo -e "${YELLOW}4. Package-qualified imports (non-blocking)${NC}"

warn_check "from flow_sdk.config import load_server_info" \
    "$PYTHON" -c "from flow_sdk.config import load_server_info"

warn_check "from flow_sdk.db.db_entity import BaseEntity" \
    "$PYTHON" -c "from flow_sdk.db.db_entity import BaseEntity"

warn_check "from flow_sdk.actions.action_registry import ActionRegistry" \
    "$PYTHON" -c "from flow_sdk.actions.action_registry import ActionRegistry"

echo ""

# =============================================
# Summary
# =============================================

TOTAL=$((PASS + FAIL))
echo -e "${YELLOW}=== Results: ${PASS}/${TOTAL} passed, ${WARN} warnings ===${NC}"

if [[ $FAIL -gt 0 ]]; then
    echo -e "${RED}FAILED: ${FAIL} critical check(s) did not pass${NC}"
    exit 1
fi

if [[ $WARN -gt 0 ]]; then
    echo -e "${YELLOW}Note: ${WARN} non-blocking warning(s) — bare-import issue${NC}"
fi

echo -e "${GREEN}ALL CRITICAL CHECKS PASSED${NC}"
exit 0
