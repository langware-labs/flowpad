"""Integration test: parse real ~/.claude/debug logs from the last hour.

Greps expected error counts per session, then compares against
ClaudeSessionDebugLogRecord.from_debug_file() parser output.
"""

import os
import re
import time
from pathlib import Path

import pytest

from flow_sdk.fs_records.claude.claude_debug_log import (
    ClaudeSessionDebugLogRecord,
)

# Same patterns as parse_debug_log — grep baseline must agree with the parser
_HOOK_MARKER_RE = re.compile(r"Hook .+? \([^)]+\) error:")
_LOG_ERROR_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+\[ERROR\]\s+")


def _grep_error_counts(path: Path) -> tuple[int, int]:
    """Count hook-error markers and [ERROR] log lines via grep (single pass).

    Returns (hook_error_count, log_error_count).
    """
    hook_count = 0
    log_count = 0
    with open(path, "r", errors="replace") as f:
        for line in f:
            if _HOOK_MARKER_RE.search(line):
                hook_count += 1
            elif _LOG_ERROR_RE.search(line):
                log_count += 1
    return hook_count, log_count


def _recent_debug_logs(max_files: int = 2, hours: float = 1.0) -> list[Path]:
    """Return up to *max_files* debug logs modified within the last *hours*, newest first."""
    debug_dir = ClaudeSessionDebugLogRecord.debug_dir()
    if not debug_dir.is_dir():
        return []
    cutoff = time.time() - (hours * 3600)
    files = [
        Path(e.path)
        for e in os.scandir(debug_dir)
        if e.name.endswith(".txt") and e.stat().st_mtime >= cutoff
    ]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:max_files]


@pytest.fixture(scope="module")
def recent_logs() -> list[Path]:
    logs = _recent_debug_logs(max_files=2, hours=1.0)
    if not logs:
        pytest.skip("No debug logs found in the last hour")
    return logs


def test_recent_logs_found(recent_logs):
    """At least one recent debug log exists."""
    assert len(recent_logs) >= 1
    assert len(recent_logs) <= 2
    for p in recent_logs:
        assert p.exists()
        assert p.suffix == ".txt"


def test_grep_counts_per_session(recent_logs):
    """Print and sanity-check the raw grep counts for each session."""
    for path in recent_logs:
        hook_count, log_count = _grep_error_counts(path)
        total = hook_count + log_count
        print(f"\n{path.stem}: hook_errors={hook_count}, log_errors={log_count}, total={total}")
        # Counts are non-negative integers — trivially true, but explicit
        assert hook_count >= 0
        assert log_count >= 0


def test_parser_matches_grep(recent_logs):
    """ClaudeSessionDebugLogRecord error_count must match the grep baseline for each session."""
    for path in recent_logs:
        hook_grep, log_grep = _grep_error_counts(path)
        expected_total = hook_grep + log_grep

        rec = ClaudeSessionDebugLogRecord.from_debug_file(path)

        assert rec.session_id == path.stem, \
            f"session_id mismatch: {rec.session_id!r} vs {path.stem!r}"
        assert rec.error_count == expected_total, (
            f"{path.stem}: parser counted {rec.error_count} errors "
            f"(hook={len(rec.hook_errors)}, log={len(rec.log_errors)}), "
            f"grep counted {expected_total} (hook={hook_grep}, log={log_grep})"
        )
        assert len(rec.hook_errors) == hook_grep, \
            f"{path.stem}: hook_errors count mismatch"
        assert len(rec.log_errors) == log_grep, \
            f"{path.stem}: log_errors count mismatch"
        assert rec.has_errors == (expected_total > 0)
