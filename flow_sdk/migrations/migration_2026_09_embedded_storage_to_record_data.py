"""One-shot: carry every message's attachment bytes into its record-data folder.

FILE (``data/<name>``) and PROMPT-file (``prompt/<name>``) bytes used to live
under ``<OS temp>/flow-embedded-storage/``, which macOS empties at boot. They now
live in ``<records_data>/flow_message/<id>/embedded/``. Nothing moves them on its
own, so on upgrade every still-intact file would stop resolving, and the next
reboot would destroy the only copy.

For each message with a file attachment whose bytes are missing from the new
home, copy them back from the message's own unpacked bundle, else the old temp
root (``restore_attachment_file``). Copies, never moves: every instance on the
machine shared that temp root. Idempotent: a message whose bytes are already
home is skipped.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_09_embedded_storage_to_record_data
    uv run -m flow_sdk.migrations.migration_2026_09_embedded_storage_to_record_data --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)


def _file_refs(blob: str | None) -> list[str]:
    """The VFS subpaths of a message's byte-bearing attachments."""
    from flow_sdk.builtin.flow_message import FILE_VFS_PREFIX, PROMPT_FILE_VFS_PREFIX

    try:
        atts = json.loads(blob or "{}").get("attachment") or []
    except Exception:  # noqa: BLE001
        return []
    return [
        a["data"] for a in atts
        if isinstance(a, dict) and str(a.get("data") or "").startswith((FILE_VFS_PREFIX, PROMPT_FILE_VFS_PREFIX))
    ]


def migrate(db_path: Path | None = None, *, dry_run: bool = True) -> dict[str, int]:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.fs_store.operations.flow_message import lost_attachment_source, restore_attachment_file
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.instance_settings import get_instance_settings
    from flow_sdk.storage import get_entity_embedded_storage

    counts = {"files": 0, "present": 0, "restored": 0, "unrecoverable": 0}
    conn = open_sqlite(db_path or get_instance_settings().db_path)
    try:
        rows = conn.execute(
            "SELECT id, data FROM entities WHERE type = 'flow_message' AND data LIKE '%\"attachment_type\"%'"
        ).fetchall()
    finally:
        conn.close()
    for fm_id, blob in rows:
        storage = None
        for raw in _file_refs(blob):
            counts["files"] += 1
            storage = storage or get_entity_embedded_storage(TypeId(type="flow_message", id=fm_id))
            dest = Path(storage.get_storage_path(raw))
            if dest.is_file():
                counts["present"] += 1
            elif lost_attachment_source(fm_id, raw) is None:
                counts["unrecoverable"] += 1
            else:
                counts["restored"] += 1
                if not dry_run:
                    restore_attachment_file(fm_id, raw, dest)
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    logger.info("Mode: %s", "APPLY" if args.apply else "DRY-RUN")
    logger.info("attachment files: %s", migrate(dry_run=not args.apply))
    return 0


if __name__ == "__main__":
    sys.exit(main())
