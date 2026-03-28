#!/usr/bin/env bash
# Memory leak analysis for the flowpad server.
# Runs the test suite under memray and generates a flamegraph + leak report.
#
# Usage:
#   ./scripts/memory_check.sh          # full run (unit + api + long tests)
#   ./scripts/memory_check.sh --quick  # unit + api only, no long tests
#
# Output:
#   /tmp/flowpad_memory.bin            - raw memray capture
#   /tmp/flowpad_memory_report.html    - flamegraph (open in browser)

set -e

BIN=/tmp/flowpad_memory.bin
REPORT=/tmp/flowpad_memory_report.html
DB=/tmp/flowpad_memray_test.db
QUICK=false

for arg in "$@"; do
  case $arg in
    --quick) QUICK=true ;;
  esac
done

# ── Phase 1: Quick live trace ─────────────────────────────────────────────────
echo ""
echo "=== Phase 1: Live trace (unit + api) ==="
echo "    An interactive TUI will open. Press 'q' to exit and continue."
echo ""
memray run --live python -m pytest tests/unit/ tests/api/ -x -q

# ── Phase 2: Full e2e capture ─────────────────────────────────────────────────
echo ""
if [ "$QUICK" = true ]; then
  echo "=== Phase 2: Capture trace (unit + api only) ==="
  DEEP_TESTING=false SQLITE_DATABASE_PATH=$DB \
    memray run --aggregate -o $BIN \
    python -m pytest tests/unit/ tests/api/ -v --timeout=120
else
  echo "=== Phase 2: Capture trace (full e2e — unit + api + long tests) ==="
  DEEP_TESTING=true SQLITE_DATABASE_PATH=$DB \
    memray run --aggregate -o $BIN \
    python -m pytest tests/unit/ tests/api/ tests/long_tests/ -v --timeout=120
fi

# ── Phase 3: Generate leakage report ─────────────────────────────────────────
echo ""
echo "=== Phase 3: Leakage report ==="
echo ""
echo "--- Leaked allocations (never freed) ---"
memray stats $BIN --show-memory-leaks

echo ""
echo "--- Summary stats ---"
memray stats $BIN

echo ""
echo "--- Generating flamegraph ---"
memray flamegraph $BIN -o $REPORT

echo ""
echo "=========================================="
echo "  Report: $REPORT"
echo "  Open in browser to explore the flamegraph."
echo "=========================================="
