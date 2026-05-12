#!/usr/bin/env bash
# Apply per-scenario corruption to /work, then exec the runner.
#
# Reads SCENARIO from env. Unknown scenarios fail with exit 64 and a
# RUNNER_BLOCKED line so the harness can't silently misroute.
#
# Phase 1 cells (this file grows as cells are added):
#   happy_path  — no corruption applied
set -eu

SCENARIO="${SCENARIO:-happy_path}"

case "$SCENARIO" in
    happy_path)
        : # no-op
        ;;
    *)
        echo "RUNNER_BLOCKED: unknown SCENARIO=$SCENARIO" >&2
        exit 64
        ;;
esac

exec python /opt/runner_entrypoint.py "$@"
