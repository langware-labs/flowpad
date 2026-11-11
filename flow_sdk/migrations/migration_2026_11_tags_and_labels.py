"""One-shot rewrite: ``labels`` is gone, and every stored tag is a valid one.

``Entity.labels`` held two things that were never classification, and both moved to
a field of their own:

* an annotation's kind markers (``note:``, ``comment:``, ...) -> ``Annotation.subkind``;
* the desktop user's two flags -> ``User.desktop`` / ``User.name_overridden``.

After that the key is dropped from every row. ``tags`` is the one classification
field (docs/tags.md), so in the same pass every stored ``tags`` list is rewritten
through ``to_tags`` (``Meeting Notes`` -> ``meeting-notes``, the ``"[a"`` / ``"b]"``
halves an old header parser left -> ``a`` / ``b``), and a skill's header tags, which
used to sit in ``metadata.tags``, are lifted into it.

Rows are rewritten in place with raw SQL: the entity classes no longer know
``labels``, so loading a row through them would drop the very thing being moved.
The same mapping also runs on read (``Annotation`` / ``User`` validators), so a row
this script has not reached yet still loads right.

Idempotent — a clean instance reports zeros and writes nothing.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_11_tags_and_labels
    uv run -m flow_sdk.migrations.migration_2026_11_tags_and_labels --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class Report:
    #: ``{row id: new data}`` — what a write would store.
    rewritten: dict[str, dict[str, Any]] = field(default_factory=dict)
    labels_dropped: int = 0
    tags_converted: int = 0
    skill_tags_lifted: int = 0

    def summary(self, dry_run: bool = False) -> str:
        if not self.rewritten:
            return "tags and labels: nothing to rewrite."
        verb = "would rewrite" if dry_run else "rewrote"
        return (
            f"tags and labels: {verb} {len(self.rewritten)} row(s) — labels moved off {self.labels_dropped}, "
            f"tags converted on {self.tags_converted}, skill header tags lifted on {self.skill_tags_lifted}."
        )


def rewrite(row_type: str, data: dict[str, Any], report: Report) -> dict[str, Any] | None:
    """``data`` as it should be stored, or None when it is already right."""
    from flow_sdk.builtin.annotation import subkind_of_labels  # noqa: PLC0415
    from flow_sdk.builtin.user import flags_of_labels  # noqa: PLC0415
    from flow_sdk.tags.grammar import to_tags  # noqa: PLC0415

    new = dict(data)
    if "labels" in new:
        labels = new.pop("labels") or []
        if row_type == "annotation" and not new.get("subkind"):
            new["subkind"] = subkind_of_labels(labels)
        elif row_type == "user":
            new.update({flag: bool(new.get(flag)) or held for flag, held in flags_of_labels(labels).items()})
        report.labels_dropped += 1
    tags = to_tags(new.get("tags"))
    metadata = new.get("metadata")
    if row_type == "skill" and not tags and isinstance(metadata, dict) and metadata.get("tags"):
        tags = to_tags(metadata["tags"])
        report.skill_tags_lifted += bool(tags)
    if "tags" in new and tags != new["tags"] or "tags" not in new and tags:
        new["tags"] = tags
        report.tags_converted += 1
    return None if new == data else new


def plan(conn) -> Report:
    report = Report()
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='entities'").fetchone():
        return report
    rows = conn.execute(
        "SELECT id, type, data FROM entities WHERE data LIKE '%\"labels\"%' OR data LIKE '%\"tags\"%' ORDER BY id"
    )
    for row_id, row_type, raw in rows:
        try:
            data = json.loads(raw or "{}")
        except ValueError:
            continue
        new = rewrite(row_type, data, report) if isinstance(data, dict) else None
        if new is not None:
            report.rewritten[row_id] = new
    return report


def migrate(dry_run: bool = True, db: Path | None = None) -> Report:
    """Move ``labels`` off every row and make every stored tag valid."""
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    conn = open_sqlite(str(db or get_instance_settings().db_path))
    try:
        report = plan(conn)
        if not dry_run and report.rewritten:
            conn.executemany(
                "UPDATE entities SET data = ? WHERE id = ?",
                [(json.dumps(data), row_id) for row_id, data in report.rewritten.items()],
            )
            conn.commit()
        return report
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--db", type=Path, default=None, help="Target DB (default: this instance).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    report = migrate(dry_run=not args.apply, db=args.db)
    logger.info(report.summary(dry_run=not args.apply))
    return 0


if __name__ == "__main__":
    sys.exit(main())
