#!/usr/bin/env bash
# Apply per-scenario corruption to the runtime, then exec the runner.
#
# Reads SCENARIO from env. Unknown scenarios fail with exit 64 and a
# RUNNER_BLOCKED line so the harness can't silently misroute.
#
# Phase 1 cells:
#   happy_path            — no corruption (baseline)
#   no_claude_binary      — G1: PATH stripped of claude
#   broken_claude_binary  — G2: fake claude on PATH that exits nonzero
#   db_corrupted          — A2: pre-write garbage to the SQLite DB path
#   db_readonly           — A3: pre-create the DB file with no write perm
set -eu

SCENARIO="${SCENARIO:-happy_path}"
WORKDIR="${1:-/work}"
DB_PATH="$WORKDIR/.stress_db.sqlite"

case "$SCENARIO" in
    happy_path)
        : # no-op
        ;;

    no_ap_record)
        # B1: runner skips ``ap.save([])`` and calls prompt() against an
        # in-memory-only AgenticProcess. Today this hits the exist_in_db
        # gate at agentic_process.py:1088 and fails. After the surgical
        # fix it should run cleanly.
        export STRESS_NO_AP_SAVE=1
        ;;

    no_claude_binary | broken_claude_binary)
        # Both cells corrupt /usr/local/bin/claude via a docker -v bind mount
        # set up by the host harness (run_cell extra_mounts). Nothing to do
        # in victimize.sh — the corruption is already in place by the time
        # we run.
        : # no-op
        ;;

    db_corrupted)
        # Place garbage at the SQLite path BEFORE init_db. Either the open
        # call fails fast or schema-detection raises a clear sqlite error.
        echo "not-a-sqlite-database-stress-matrix-A2" > "$DB_PATH"
        ;;

    db_readonly)
        # The DB file is bind-mounted read-only by the harness via docker
        # ``-v <host_path>:/work/.stress_db.sqlite:ro``. Nothing to do
        # here — chmod-from-inside-container is unreliable on macOS Docker
        # Desktop (the gRPC FUSE bind-mount layer doesn't honour mode bits).
        : # no-op
        ;;

    *)
        echo "RUNNER_BLOCKED: unknown SCENARIO=$SCENARIO" >&2
        exit 64
        ;;
esac

exec python /opt/runner_entrypoint.py "$@"
