#!/bin/bash
#
# Release notes for the deploy, written in parallel with the rest of it.
#
#   scripts/release_notes.sh start  <version>   # fresh -> nothing; else starts the release-notes skill in the background
#   scripts/release_notes.sh finish <version>   # waits for that run, then requires the notes to be fresh
#
# The notes live in flow_sdk/system_projects/flowpad_assistant/releases/<version>/RELEASE_NOTES.md and ship
# in that version's wheel, so `finish` runs before the version-bump commit. plan.py hashes only user-visible
# commits: a rerun with no real change is `fresh` and the skill is not started at all.
set -euo pipefail

CMD="${1:?start|finish}"
VERSION="${2:?version}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PLAN=".claude/skills/release-notes/scripts/plan.py"
LOG_DIR="${HOME}/.flow/logs"
LOG="${LOG_DIR}/release-notes-${VERSION}.log"
PID_FILE="${LOG_DIR}/release-notes-${VERSION}.pid"
CLAUDE_BIN="${RELEASE_NOTES_CLAUDE:-claude}"

status() { python3 "$PLAN" "$VERSION" --status; }

case "$CMD" in
    start)
        mkdir -p "$LOG_DIR"
        rm -f "$PID_FILE"
        if [[ "$(status)" == "fresh" ]]; then
            echo "Release notes for ${VERSION} are up to date — not regenerating."
            exit 0
        fi
        nohup "$CLAUDE_BIN" -p "/release-notes ${VERSION}" --permission-mode acceptEdits >"$LOG" 2>&1 &
        echo $! >"$PID_FILE"
        echo "Release notes for ${VERSION}: writing in the background (log: ${LOG})."
        ;;
    finish)
        if [[ -f "$PID_FILE" ]]; then
            PID=$(cat "$PID_FILE")
            echo "Waiting for the release-notes run (pid ${PID})..."
            while kill -0 "$PID" 2>/dev/null; do sleep 2; done
            rm -f "$PID_FILE"
        fi
        if [[ "$(status)" != "fresh" ]]; then
            echo "Error: release notes for ${VERSION} are not fresh after the run. See ${LOG}." >&2
            exit 1
        fi
        echo "Release notes for ${VERSION} are ready."
        ;;
    *) echo "usage: $0 start|finish <version>" >&2; exit 2 ;;
esac
