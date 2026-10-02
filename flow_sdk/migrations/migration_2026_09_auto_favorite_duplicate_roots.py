"""One-shot repair: collapse duplicated `flow show` auto-bookmark trees.

The auto tree (``Auto / <type> / item``, ``source="auto"``) is meant to be
found-or-created — exactly one root, one subfolder per type, one leaf per
target, per project. Two things broke that:

1. **Same-bucket duplicates.** ``mint_auto_favorite`` scans, then saves, with
   no lock. Two shows landing together in one project both miss the root and
   both mint one, and the same race forks the per-type subfolder and the leaf.

2. **Cross-bucket duplicates.** The scan is keyed on ``project_id``
   (``scope_filter``), so a tree written before project stamping existed
   (``project_id`` NULL) is invisible to a scoped show, which mints a second
   root beside it — while the frontend's ``bookmarkInScope`` rendered an
   unscoped bookmark in EVERY scope. Two "Auto" folders, side by side, in a
   project that only ever had one tree.

The visibility half of (2) is fixed at the source (``ui/src/lib/bookmark-scope.ts``
now scopes ``source="auto"`` rows like the writer does), so a legacy unscoped
tree stops double-rendering without being touched. This script is for the rows
themselves: it collapses every duplicate the races already wrote, and — only
when asked — clears out a legacy unscoped tree that a project-scoped install no
longer surfaces.

Rules, applied per ``(owner, project bucket)`` so one project's tree is never
merged into another's:

* several **roots** in a bucket ⇒ keep the oldest, re-file the others' children
  under it, delete the extras;
* several **subfolders** of one root sharing a ``data.auto_type`` ⇒ keep the
  oldest, re-file, delete the extras;
* several **leaves** in a bucket sharing ``(entity_type, entity_id)`` ⇒ keep the
  oldest, delete the extras.

Oldest wins everywhere: it is the row the UI has been showing, the one carrying
any manual ``order``/``counter`` the user has built up.

Idempotent — a collapsed instance reports nothing and writes nothing, so
re-running is a no-op. Only ``source="auto"`` rows are ever read or written; a
hand-starred favorite is out of scope even when it points at the same entity.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_09_auto_favorite_duplicate_roots
    uv run -m flow_sdk.migrations.migration_2026_09_auto_favorite_duplicate_roots --apply

A legacy unscoped tree is REPORTED but kept unless you ask for it to go:
    ... --apply --drop-unscoped     # only for owners who also have scoped trees
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BOOKMARK_TYPE = "bookmark"
AUTO_SOURCE = "auto"
FAVORITE = "favorite"
FAVORITE_FOLDER = "favorite_folder"


@dataclass
class Row:
    """One auto-tree bookmark, flattened out of its JSON blob."""

    id: str
    created: str
    owner: str
    bucket: str          # project_id, "" for the unscoped tree
    parent_id: str
    bookmark_type: str
    payload: dict[str, Any]  # the nested `data` dict

    @property
    def is_root(self) -> bool:
        return bool(self.payload.get("auto_root"))

    @property
    def auto_type(self) -> str:
        return str(self.payload.get("auto_type") or "")

    @property
    def target(self) -> tuple[str, str]:
        return (
            str(self.payload.get("entity_type") or ""),
            str(self.payload.get("entity_id") or ""),
        )

    # Oldest first; the id breaks a tie so two rows written in the same
    # millisecond still collapse deterministically.
    @property
    def rank(self) -> tuple[str, str]:
        return (self.created or "", self.id)


@dataclass
class Report:
    """The plan AND its summary — one object, so a count can never drift from
    the collection it counts."""

    #: One line per collapse, e.g. "root p=…/owner=…: kept … dropped 1".
    groups: list[str] = field(default_factory=list)
    #: Bookmark ids to delete.
    doomed: list[str] = field(default_factory=list)
    #: child id -> new parent id, applied before the deletes.
    reparent: dict[str, str] = field(default_factory=dict)
    #: Owners carrying a legacy unscoped tree beside project-scoped ones.
    unscoped_trees: list[str] = field(default_factory=list)

    @property
    def rows_deleted(self) -> int:
        return len(self.doomed)

    @property
    def rows_reparented(self) -> int:
        return len(self.reparent)


def _db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().db_path)


def _open(db: Path | None = None):
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    return open_sqlite(str(db or _db_path()))


def _has_table(conn, name: str) -> bool:
    return bool(
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
    )


def _scan(conn) -> list[Row]:
    """Every ``source="auto"`` favorite/folder, cheapest-first: the source test
    is pushed into SQL so a bookmark table full of manual favorites never
    reaches Python."""
    rows: list[Row] = []
    sql = (
        "SELECT id, created_date, created_by, data FROM entities"
        " WHERE type = ? AND json_extract(data, '$.source') = ?"
    )
    for rid, created, created_by, blob in conn.execute(sql, (BOOKMARK_TYPE, AUTO_SOURCE)):
        try:
            data = json.loads(blob or "{}")
        except Exception:  # noqa: BLE001
            continue
        bookmark_type = str(data.get("bookmark_type") or "")
        if bookmark_type not in (FAVORITE, FAVORITE_FOLDER):
            continue
        payload = data.get("data")
        rows.append(
            Row(
                id=str(rid),
                created=str(created or ""),
                # `save(owner)` stamps the owner here; the role relationship is
                # the same fact, but this one needs no join.
                owner=str(created_by or data.get("created_by") or ""),
                # "" and NULL both mean "no project" — fold them, exactly as
                # `mint_auto_favorite` does, or the unscoped tree splits in two.
                bucket=str(data.get("project_id") or ""),
                parent_id=str(data.get("parent_id") or ""),
                bookmark_type=bookmark_type,
                payload=payload if isinstance(payload, dict) else {},
            )
        )
    return rows


def _collapse_bucket(rows: list[Row], report: Report, label: str) -> tuple[list[str], dict[str, str]]:
    """Plan one ``(owner, project)`` tree. Returns the ids to delete and the
    ``child id -> new parent id`` re-filings, without touching the DB."""
    doomed: list[str] = []
    reparent: dict[str, str] = {}

    def _merge(dupes: list[Row], what: str) -> Row:
        """Keep the oldest of an equivalent set; re-file the others' children
        onto it and mark them for deletion."""
        keeper, *extras = sorted(dupes, key=lambda r: r.rank)
        if extras:
            report.groups.append(
                f"{what} {label}: kept {keeper.id[:8]} dropped "
                + ",".join(e.id[:8] for e in extras)
            )
            for extra in extras:
                for child in rows:
                    # Follow re-filings already planned in this pass, so a child
                    # of a doomed folder never lands on another doomed folder.
                    if reparent.get(child.id, child.parent_id) == extra.id:
                        reparent[child.id] = keeper.id
                doomed.append(extra.id)
        return keeper

    def _group_and_merge(keep, key_of, label_of) -> None:
        """Collapse every set of rows that share a key — the shape both the
        subfolder pass and the leaf pass need."""
        groups: dict[Any, list[Row]] = {}
        for r in rows:
            if r.id in doomed or not keep(r):
                continue
            groups.setdefault(key_of(r), []).append(r)
        for key, members in groups.items():
            _merge(members, label_of(key))

    roots = [r for r in rows if r.is_root]
    if not roots:
        return doomed, reparent
    root = _merge(roots, "root")

    # Subfolders of the surviving root, one per auto_type.
    _group_and_merge(
        lambda r: (
            not r.is_root
            and r.bookmark_type == FAVORITE_FOLDER
            and bool(r.auto_type)
            and reparent.get(r.id, r.parent_id) == root.id
        ),
        lambda r: r.auto_type,
        lambda t: f"subfolder[{t}]",
    )
    # Leaves, one per target. The bucket holds a single tree by now, so a
    # bucket-wide grouping is the whole tree's grouping.
    _group_and_merge(
        lambda r: r.bookmark_type == FAVORITE and bool(r.target[1]),
        lambda r: r.target,
        lambda t: f"leaf[{t[0]}]",
    )
    # No filtering needed on the way out: `_merge` re-chases a doomed row's
    # dependents onto the keeper as it goes, so no reparent target can be a
    # row this pass deleted.
    return doomed, reparent


def plan(conn, drop_unscoped: bool = False) -> Report:
    """Everything the migration would do, computed without writing."""
    report = Report()
    if not _has_table(conn, "entities"):
        return report

    rows = _scan(conn)
    buckets: dict[tuple[str, str], list[Row]] = {}
    for r in rows:
        buckets.setdefault((r.owner, r.bucket), []).append(r)

    doomed = report.doomed
    reparent = report.reparent
    for (owner, bucket), bucket_rows in sorted(buckets.items()):
        label = f"owner={owner[:8] or '-'} project={bucket[:8] or 'NONE'}"
        d, rp = _collapse_bucket(bucket_rows, report, label)
        doomed.extend(d)
        reparent.update(rp)

    # A legacy unscoped tree next to project-scoped ones: the reason a project
    # showed two "Auto" folders before `bookmarkInScope` learned to scope auto
    # rows. Reported always; removed only on request, because its leaves are
    # real (if project-less) history.
    owners_with_scoped = {o for (o, b) in buckets if b}
    for (owner, bucket), bucket_rows in sorted(buckets.items()):
        if bucket or owner not in owners_with_scoped:
            continue
        live = [r for r in bucket_rows if r.id not in doomed]
        report.unscoped_trees.append(
            f"owner={owner[:8] or '-'}: {len(live)} unscoped auto row(s)"
            + (" — dropped" if drop_unscoped else " — kept (pass --drop-unscoped to remove)")
        )
        if drop_unscoped:
            doomed.extend(r.id for r in live)

    # The unscoped drop above adds to `doomed` AFTER the per-bucket collapse,
    # so a re-filing planned earlier can point at a row that is now going.
    dropped = set(doomed)
    report.reparent = {
        k: v for k, v in reparent.items() if k not in dropped and v not in dropped
    }
    return report


#: SQLite's oldest ``SQLITE_MAX_VARIABLE_NUMBER``. A single owner's legacy tree
#: can exceed it under ``--drop-unscoped``, so the deletes are chunked.
_MAX_VARS = 999


def _apply(conn, report: Report) -> None:
    """Re-file first, then delete — a crash between the two leaves children
    already safe under the keeper rather than pointing at a deleted folder."""
    if report.reparent:
        conn.executemany(
            "UPDATE entities SET data = json_set(data, '$.parent_id', ?)"
            " WHERE id = ? AND type = ?",
            [(parent, cid, BOOKMARK_TYPE) for cid, parent in sorted(report.reparent.items())],
        )
    has_rels = _has_table(conn, "relationships")
    doomed = report.doomed
    # Halved for the relationships statement, which binds each id twice.
    for start in range(0, len(doomed), _MAX_VARS // 2):
        chunk = doomed[start : start + _MAX_VARS // 2]
        marks = ",".join("?" * len(chunk))
        conn.execute(f"DELETE FROM entities WHERE id IN ({marks})", chunk)
        # The owner edge (`role`/owner) and any other edge would otherwise
        # outlive its bookmark.
        if has_rels:
            conn.execute(
                f"DELETE FROM relationships WHERE from_id IN ({marks}) OR to_id IN ({marks})",
                [*chunk, *chunk],
            )
    conn.commit()


def dedupe(dry_run: bool = True, db: Path | None = None, drop_unscoped: bool = False) -> Report:
    """Collapse duplicate auto trees. Returns what was (or would be) done."""
    conn = _open(db)
    try:
        report = plan(conn, drop_unscoped=drop_unscoped)
        if dry_run:
            # The plan is still reported; the counts read 0 because nothing ran.
            return replace(report, doomed=[], reparent={})
        _apply(conn, report)
        return report
    finally:
        conn.close()


def _print(report: Report, dry_run: bool) -> None:
    for line in report.groups:
        logger.info("  %s", line)
    for line in report.unscoped_trees:
        logger.info("  unscoped tree: %s", line)
    if not report.groups and not report.unscoped_trees:
        logger.info("  nothing to collapse")
    logger.info(
        "auto bookmarks: deleted=%d reparented=%d%s",
        report.rows_deleted,
        report.rows_reparented,
        " (dry-run — nothing written)" if dry_run else "",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument(
        "--drop-unscoped",
        action="store_true",
        help="Also delete a legacy unscoped auto tree, for owners who have project-scoped ones.",
    )
    parser.add_argument("--db", type=Path, default=None, help="Target DB (default: this instance).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")
    try:
        report = dedupe(dry_run=dry_run, db=args.db, drop_unscoped=args.drop_unscoped)
    except Exception as e:  # noqa: BLE001
        logger.exception("Auto-favorite dedupe failed: %s", e)
        return 1
    _print(report, dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
