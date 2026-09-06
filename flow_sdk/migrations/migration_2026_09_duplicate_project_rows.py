"""One-shot repair: merge Project rows that share one mount path.

``fs_storage_mount_path`` is a Project's natural key — ``Project.find_by_cwd``
is the documented dedup, and every creator is supposed to be
``find_by_cwd or save-new``. That upsert is a check-then-create with no
uniqueness constraint behind it, so a second row for a folder that already has
one does get written (observed on the `prod` instance: two `flowpad-oss` rows
for ``~/Flowpad workspace/flowpad-oss``, and reproduced 2/2 on the git-clone
path, where two rows landed 40-120ms apart).

Why a duplicate is not cosmetic: the readers disagreed about which row owns the
folder. ``find_by_cwd`` and ``index_by_mount`` document first-match; the project
scan in ``fs_store/operations/all_projects.py`` overwrote as it went and so
answered with the LAST row. One folder, two project ids, depending on who asked
— which is how a session got labelled with one id while the UI scope carried the
other, and a scoped list came back empty. (That scan now uses ``setdefault``, so
the three entity-layer readers agree; this script is for the rows the races
already wrote. Note the two raw readers in ``fs_store/indexer/roots.py`` —
``load_project_mounts`` and ``_lookup_project_id_by_cwd`` — still have weaker
tie-breaks of their own, so merging the rows is what actually removes the
ambiguity for every caller.)

Rules, per canonical mount path:

* the **keeper** is the row that is actually in use — referenced by another
  entity, or carrying ``last_active_at``/``last_mode`` — and the oldest such row
  when several qualify. With no signal anywhere, oldest wins. Oldest is also
  what ``find_by_cwd`` returns, so the merge keeps the row the app has been
  resolving to rather than switching identities under the user;
* every other row and relationship that mentions a **loser** is repointed at the
  keeper. A project id is a globally unique uuid, so "mentions" is exact;
* each loser's **default Wiki** (``default_wiki_id(loser)``, a v5 derived from
  the project id) is deleted rather than repointed — the keeper already owns its
  own deterministic wiki, and repointing would leave the project with two;
* a loser whose wiki holds entries, or that carries a **different hub identity**
  (``remote``), is left alone and REPORTED. Those are the two cases where a
  second row at one path can be deliberate, and a merge would lose something.

Idempotent — a deduped instance reports nothing and writes nothing.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_09_duplicate_project_rows
    uv run -m flow_sdk.migrations.migration_2026_09_duplicate_project_rows --apply
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

PROJECT_TYPE = "project"
WIKI_TYPE = "wiki"


@dataclass
class Row:
    """One Project row, flattened out of its JSON blob."""

    id: str
    created: str
    mount: str
    payload: dict[str, Any]

    @property
    def remote(self) -> bool:
        return bool(self.payload.get("remote"))

    @property
    def has_activity(self) -> bool:
        """Evidence a person opened this row: the `activate` stamp, or the view
        mode an open writes. Absent on a row nothing ever used."""
        return bool(self.payload.get("last_active_at") or self.payload.get("last_mode"))

    # Oldest first; the id breaks a tie so two rows written in the same
    # millisecond still collapse deterministically.
    @property
    def rank(self) -> tuple[str, str]:
        return (self.created or "", self.id)


@dataclass
class Report:
    """The plan AND its summary — one object, so a count can never drift from
    the collection it counts."""

    #: One line per merge, e.g. "/path: kept 6b4fb358 dropped 1255c619".
    groups: list[str] = field(default_factory=list)
    #: Groups left alone, with the reason.
    skipped: list[str] = field(default_factory=list)
    #: Project ids to delete.
    doomed: list[str] = field(default_factory=list)
    #: Default-wiki ids to delete alongside their project.
    doomed_wikis: list[str] = field(default_factory=list)
    #: loser id -> keeper id, applied to every other row before the deletes.
    repoint: dict[str, str] = field(default_factory=dict)

    @property
    def rows_deleted(self) -> int:
        return len(self.doomed) + len(self.doomed_wikis)

    @property
    def projects_merged(self) -> int:
        return len(self.repoint)


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


def _canonical(path: str) -> str:
    """Canonicalize exactly as the readers do, so this script groups the rows
    they would collide on — not a lookalike set of its own."""
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    try:
        return canonical_posix_path(path)
    except (OSError, ValueError):
        return path


def _default_wiki_id(project_id: str) -> str:
    from flow_sdk.wiki.service import default_wiki_id

    return str(default_wiki_id(project_id))


def _scan(conn) -> list[Row]:
    """Every Project row that names a mount path. A row with no path has no
    natural key and can never be a duplicate of anything."""
    rows: list[Row] = []
    sql = "SELECT id, created_date, data FROM entities WHERE type = ?"
    for rid, created, blob in conn.execute(sql, (PROJECT_TYPE,)):
        try:
            data = json.loads(blob or "{}")
        except Exception:  # noqa: BLE001
            continue
        mount = str(data.get("fs_storage_mount_path") or "")
        if not mount:
            continue
        rows.append(
            Row(id=str(rid), created=str(created or ""), mount=_canonical(mount), payload=data)
        )
    return rows


def _mentions(conn, needle: str, exclude: set[str]) -> list[tuple[str, str]]:
    """``(id, data)`` for every entity whose blob names ``needle``, minus the
    rows being deleted. A project id is a uuid, so a substring hit IS a
    reference — there is no other thing it could mean."""
    out: list[tuple[str, str]] = []
    for rid, blob in conn.execute(
        "SELECT id, data FROM entities WHERE data LIKE ?", (f"%{needle}%",)
    ):
        if str(rid) in exclude:
            continue
        out.append((str(rid), blob or ""))
    return out


def _wiki_has_entries(conn, wiki_id: str) -> bool:
    """True when anything other than the wiki itself names it — an entry, a
    binding, a page. Such a wiki carries content a merge must not drop."""
    return bool(_mentions(conn, wiki_id, {wiki_id}))


def plan(conn) -> Report:
    """Everything the migration would do, computed without writing."""
    report = Report()
    if not _has_table(conn, "entities"):
        return report

    groups: dict[str, list[Row]] = {}
    for row in _scan(conn):
        groups.setdefault(row.mount, []).append(row)

    for mount, members in sorted(groups.items()):
        if len(members) < 2:
            continue

        # In use beats unused; oldest breaks the tie.
        keeper, *losers = sorted(members, key=lambda r: (not _in_use(conn, r), r.rank))

        kept: list[Row] = []
        for loser in losers:
            reason = _unsafe_reason(conn, loser)
            if reason:
                report.skipped.append(f"{mount}: left {loser.id[:8]} in place — {reason}")
                continue
            kept.append(loser)

        if not kept:
            continue
        report.groups.append(
            f"{mount}: kept {keeper.id[:8]} dropped " + ",".join(x.id[:8] for x in kept)
        )
        for loser in kept:
            report.repoint[loser.id] = keeper.id
            report.doomed.append(loser.id)
            wiki_id = _default_wiki_id(loser.id)
            if _row_exists(conn, wiki_id):
                report.doomed_wikis.append(wiki_id)
    return report


def _row_exists(conn, rid: str) -> bool:
    return bool(conn.execute("SELECT 1 FROM entities WHERE id = ?", (rid,)).fetchone())


def _in_use(conn, row: Row) -> bool:
    """Whether this row is the one the instance actually works with: opened at
    least once, or referenced by something that is not its own default wiki."""
    if row.has_activity:
        return True
    exclude = {row.id, _default_wiki_id(row.id)}
    return bool(_mentions(conn, row.id, exclude))


def _unsafe_reason(conn, loser: Row) -> str | None:
    """Why this duplicate must NOT be merged, or None when it is safe.

    Both cases are places where a second row at one path can be deliberate: a
    hub-shared project has its own identity that has to span both sides, and a
    wiki with entries holds content that repointing would not preserve (the
    keeper already owns the wiki id derived from ITS id).
    """
    if loser.remote:
        return "remote (hub-shared) project — merge by hand"
    wiki_id = _default_wiki_id(loser.id)
    if _row_exists(conn, wiki_id) and _wiki_has_entries(conn, wiki_id):
        return f"wiki {wiki_id[:8]} holds entries"
    return None


def _apply(conn, report: Report) -> None:
    """Repoint first, then delete — a crash between the two leaves references
    already pointing at the keeper rather than at a row that is gone."""
    doomed = sorted(set(report.doomed) | set(report.doomed_wikis))
    holes = ",".join("?" * len(doomed))
    for loser, keeper in sorted(report.repoint.items()):
        # Rewritten in SQL rather than blob-by-blob in Python: one statement
        # instead of a full `LIKE` scan plus a round trip per matching row, and
        # each UPDATE reads the CURRENT blob — so a row naming two losers that
        # merge into one keeper keeps both rewrites.
        conn.execute(
            "UPDATE entities SET data = replace(data, ?, ?)"
            f" WHERE data LIKE ? AND id NOT IN ({holes})",
            (loser, keeper, f"%{loser}%", *doomed),
        )
        if _has_table(conn, "relationships"):
            conn.execute("UPDATE relationships SET from_id = ? WHERE from_id = ?", (keeper, loser))
            conn.execute("UPDATE relationships SET to_id = ? WHERE to_id = ?", (keeper, loser))

    for rid in sorted(doomed):
        conn.execute("DELETE FROM entities WHERE id = ?", (rid,))
        if _has_table(conn, "relationships"):
            conn.execute(
                "DELETE FROM relationships WHERE from_id = ? OR to_id = ?", (rid, rid)
            )
    conn.commit()


def dedupe(dry_run: bool = True, db: Path | None = None) -> Report:
    """Merge duplicate Project rows. Returns what was (or would be) done."""
    conn = _open(db)
    try:
        report = plan(conn)
        if dry_run:
            # The plan is still reported; the counts read 0 because nothing ran.
            return replace(report, doomed=[], doomed_wikis=[], repoint={})
        _apply(conn, report)
        return report
    finally:
        conn.close()


def _print(report: Report, dry_run: bool) -> None:
    for line in report.groups:
        logger.info("  %s", line)
    for line in report.skipped:
        logger.info("  skipped: %s", line)
    if not report.groups and not report.skipped:
        logger.info("  no duplicate project rows")
    logger.info(
        "duplicate projects: merged=%d rows_deleted=%d%s",
        report.projects_merged,
        report.rows_deleted,
        " (dry-run — nothing written)" if dry_run else "",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--db", type=Path, default=None, help="Target DB (default: this instance).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")
    try:
        report = dedupe(dry_run=dry_run, db=args.db)
    except Exception as e:  # noqa: BLE001
        logger.exception("Duplicate-project merge failed: %s", e)
        return 1
    _print(report, dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
