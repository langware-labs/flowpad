"""Saved "auto-approve this contact" permissions leave every machine.

``ContactPermission`` let a contact's live sessions start approved, with no click from the host. It
was removed (nothing from another machine is ever approved automatically), but its rows and shadow
folders stayed behind: nothing reads them, and nothing should be able to again. This pass deletes the
``contact_permission`` rows, their relationships and their ``<records_root>/contact_permission/``
folders.

Idempotent — a clean instance reports zero and writes nothing.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_11_drop_contact_permission
    uv run -m flow_sdk.migrations.migration_2026_11_drop_contact_permission --apply
"""

from __future__ import annotations

import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

TYPE = "contact_permission"


@dataclass
class Report:
    rows: list[str] = field(default_factory=list)
    folder: Path | None = None

    def summary(self) -> str:
        where = f" and {self.folder}" if self.folder else ""
        return f"contact permissions: {len(self.rows)} row(s){where} to delete"


def plan(conn, records_root: Path) -> Report:
    report = Report()
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").fetchone():
        report.rows = [r[0] for r in conn.execute("SELECT id FROM entities WHERE type = ? ORDER BY id", (TYPE,))]
    folder = records_root / TYPE
    report.folder = folder if folder.is_dir() else None
    return report


def migrate(dry_run: bool = True, db: Path | None = None, records_root: Path | None = None) -> Report:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    from flow_sdk.fs_store.record_paths import get_default_records_root  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    conn = open_sqlite(str(db or get_instance_settings().db_path))
    try:
        report = plan(conn, records_root or get_default_records_root())
        if not dry_run:
            if report.rows:
                if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relationships'").fetchone():
                    conn.executemany(
                        "DELETE FROM relationships WHERE from_id = ? OR to_id = ?", [(i, i) for i in report.rows]
                    )
                conn.execute("DELETE FROM entities WHERE type = ?", (TYPE,))
                conn.commit()
            if report.folder is not None:
                shutil.rmtree(report.folder)
        return report
    finally:
        conn.close()


if __name__ == "__main__":
    print(migrate(dry_run="--apply" not in sys.argv).summary())  # noqa: T201 - CLI report
