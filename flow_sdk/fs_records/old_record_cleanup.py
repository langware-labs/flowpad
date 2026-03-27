"""Startup cleanup: keep only the most recent N records per type."""

import shutil
from flow_sdk.fs_store.record import get_default_records_root

MAX_SHELL_RECORDS = 200
MAX_AGENTIC_RECORDS = 200


def _cleanup_records(record_type: str, max_keep: int) -> int:
    """Delete oldest records beyond max_keep. Returns count deleted."""
    root = get_default_records_root() / record_type
    if not root.is_dir():
        return 0

    dirs = [d for d in root.iterdir() if d.is_dir()]
    if len(dirs) <= max_keep:
        return 0

    # Sort by folder mtime (oldest first); skip dirs that vanished since iterdir()
    def _safe_mtime(d):
        try:
            return d.stat().st_mtime
        except FileNotFoundError:
            return float("inf")  # treat gone dirs as newest so they're not deleted again

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
    shell_deleted = _cleanup_records("shell_session", MAX_SHELL_RECORDS)
    ap_deleted = _cleanup_records("agentic_process", MAX_AGENTIC_RECORDS)
    if shell_deleted or ap_deleted:
        print(f"  Old record cleanup: removed {shell_deleted} shell + {ap_deleted} agentic_process records")
