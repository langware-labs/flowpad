"""One-shot cleanup: the `flow show` auto-bookmark tree is gone, and so are its rows.

Every `flow show` used to file its target into a machine-built favorites tree
(``Auto / <type> / item``, ``source="auto"``). The feature is removed — a
bookmark is something the user chose — and this script removes what it wrote:

* every bookmark with ``source == "auto"`` — roots, per-type subfolders and
  leaves, including the leaves an earlier folder delete promoted to the root of
  their project, where they read as clutter the user never starred;
* every bookmark with no ``bookmark_type`` — test pollution (``new
  Bookmark({title: 'Test Bookmark'})`` in the API tier) that no surface renders
  and nothing can reach.

The second rule keys on the TYPE, never on ``source``: a favorite the UI writes
carries an empty ``source`` too, and must survive.

Raw SQL on purpose: ``Bookmark.delete`` promotes a folder's children to the
root, which is exactly the litter this cleans up — one sweep over the matching
ids deletes the whole tree without re-filing a single row first. User-made
folders and favorites are never read, let alone written.

Idempotent — a clean instance reports zeros and writes nothing.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_10_remove_auto_bookmarks
    uv run -m flow_sdk.migrations.migration_2026_10_remove_auto_bookmarks --apply
"""

from __future__ import annotations

import argparse
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

BOOKMARK_TYPE = "bookmark"
AUTO_SOURCE = "auto"

#: SQLite's oldest ``SQLITE_MAX_VARIABLE_NUMBER``; the relationships delete binds
#: each id twice, so chunks are half of it.
_MAX_VARS = 999


@dataclass
class Report:
    auto: list[str] = field(default_factory=list)
    typeless: list[str] = field(default_factory=list)

    @property
    def doomed(self) -> list[str]:
        return [*self.auto, *self.typeless]

    def summary(self, dry_run: bool = False) -> str:
        if not self.doomed:
            return "bookmarks: no auto or typeless rows left."
        verb = "would remove" if dry_run else "removed"
        return (
            f"bookmarks: {verb} {len(self.auto)} auto-bookmark row(s) "
            f"and {len(self.typeless)} typeless row(s)."
        )


def _db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().db_path)


def _open(db: Path | None = None):
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    return open_sqlite(str(db or _db_path()))


def _has_table(conn, name: str) -> bool:
    return bool(
        conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    )


def plan(conn) -> Report:
    report = Report()
    if not _has_table(conn, "entities"):
        return report
    rows = conn.execute(
        "SELECT id, json_extract(data, '$.source'), coalesce(json_extract(data, '$.bookmark_type'), '')"
        " FROM entities WHERE type = ? ORDER BY id",
        (BOOKMARK_TYPE,),
    )
    for rid, source, bookmark_type in rows:
        if source == AUTO_SOURCE:
            report.auto.append(rid)
        elif not bookmark_type:
            report.typeless.append(rid)
    return report


def _apply(conn, doomed: list[str]) -> None:
    has_rels = _has_table(conn, "relationships")
    for start in range(0, len(doomed), _MAX_VARS // 2):
        chunk = doomed[start : start + _MAX_VARS // 2]
        marks = ",".join("?" * len(chunk))
        conn.execute(f"DELETE FROM entities WHERE id IN ({marks})", chunk)
        # The owner edge would otherwise outlive its bookmark.
        if has_rels:
            conn.execute(
                f"DELETE FROM relationships WHERE from_id IN ({marks}) OR to_id IN ({marks})",
                [*chunk, *chunk],
            )
    conn.commit()


def migrate(dry_run: bool = True, db: Path | None = None) -> Report:
    """Remove auto-bookmark and typeless rows. Returns what was (or would be) removed."""
    conn = _open(db)
    try:
        report = plan(conn)
        if not dry_run and report.doomed:
            _apply(conn, report.doomed)
        return report
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--db", type=Path, default=None, help="Target DB (default: this instance).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")
    try:
        report = migrate(dry_run=dry_run, db=args.db)
    except Exception as e:  # noqa: BLE001
        logger.exception("Auto-bookmark cleanup failed: %s", e)
        return 1
    logger.info("%s", report.summary(dry_run=dry_run))
    return 0


if __name__ == "__main__":
    sys.exit(main())
