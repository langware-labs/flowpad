"""Startup record-retention housekeeping.

Keeps only the most recent N records per type under ``<records_root>/<type>/`` — except a
record holding run output younger than ``OUTPUT_KEEP_DAYS``, which the cap does not count.
Currently applies to shell + agentic_process shadow records. Not related to the
deprecated state.json/PropertyRecord machinery.
"""
from __future__ import annotations

import time
from pathlib import Path

from flow_sdk.fs_store.record_paths import get_default_records_root


MAX_SHELL_RECORDS = 200
MAX_AGENTIC_RECORDS = 200


#: How long a record holding run output is kept regardless of the count cap.
OUTPUT_KEEP_DAYS = 30


def _holds_recent_output(record: Path, now: float) -> bool:
    """``record/execution/output`` has a file, and the newest one is younger than ``OUTPUT_KEEP_DAYS``."""
    output = record / "execution" / "output"
    newest = 0.0
    try:
        for p in output.rglob("*"):
            if p.is_file():
                newest = max(newest, p.stat().st_mtime)
    except OSError:
        return False
    return newest > 0 and now - newest < OUTPUT_KEEP_DAYS * 86400


def _cleanup_records(record_type: str, max_keep: int) -> int:
    """Delete oldest records beyond max_keep. Returns count deleted."""
    import shutil

    root = get_default_records_root() / record_type
    if not root.is_dir():
        return 0

    now = time.time()
    # A run's OUTPUT is what a caller came for — ``AgenticProcess.run(output_spec=…)`` loads it, the runs
    # view shows it. A record holding output newer than ``OUTPUT_KEEP_DAYS`` is outside the count cap;
    # older ones age out like the rest (``answer.value.save(path)`` is the durable copy).
    dirs = [d for d in root.iterdir() if d.is_dir() and not _holds_recent_output(d, now)]
    if len(dirs) <= max_keep:
        return 0

    def _safe_mtime(d):
        try:
            return d.stat().st_mtime
        except FileNotFoundError:
            return float("inf")

    dirs.sort(key=_safe_mtime)
    to_delete = dirs[: len(dirs) - max_keep]

    deleted = 0
    for d in to_delete:
        try:
            shutil.rmtree(d, ignore_errors=True)
            deleted += 1
        except Exception:
            pass
    return deleted


def run_old_record_cleanup() -> None:
    """Called once at startup in a background daemon thread."""
    shell_deleted = _cleanup_records("shell", MAX_SHELL_RECORDS)
    ap_deleted = _cleanup_records("agentic_process", MAX_AGENTIC_RECORDS)
    if shell_deleted or ap_deleted:
        print(f"  Old record cleanup: removed {shell_deleted} shell + {ap_deleted} agentic_process records")
