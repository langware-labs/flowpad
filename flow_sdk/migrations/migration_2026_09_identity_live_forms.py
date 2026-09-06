"""One-shot migration: every asset id in its live carrier form, every folder
row's ``asset_ref`` at its layout root.

The live forms are ``id:`` in a markdown main document's frontmatter, a
folder's ``.flow/capsules/identity.json`` and the ``"id"`` key of a report's
json root. The retired forms this pass converts — id unchanged — are the
markdown HTML-comment ``identity`` capsule, the ``asset_id:`` frontmatter
key, the ``.flow/id`` line, a json capsule under a markdown main document and
a manifest ``id`` (``dataset.json``, ``deck.json``). Their readers are deleted
one release after this has run on every instance; a source still in a retired
form then reads as foreign.

``asset_ref`` is the folder for every folder type. Rows written while agent,
spec and the report types pointed it at the inner main file
(``<folder>/agent.md``) are rewritten to the folder.

The walk is the production indexer graph over the instance's roots — home,
cwd, the system project and every project row's mount — and identity is
settled exactly as the index walk settles it (``resolve_ref_identity``:
owner-first, writes gated by read-only roots), so what this converts is what
the next index would have converted. A source the walk cannot write (a
borrowed checkout) stays as it is and is reported.

Idempotent: a second run reads every carrier in its live form, rewrites no
row and changes no byte. Scan issues the walk raises on the way (a yaml-only
skill folder, a foreign id) are part of the report.

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_identity_live_forms --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_identity_live_forms --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

logger = logging.getLogger("migrate.identity_live_forms")


@dataclass
class RowMove:
    """One row whose ``asset_ref`` still names the inner main file."""

    type_name: str
    entity_id: str
    old: str
    new: str


@dataclass
class Report:
    scanned: int = 0
    #: legacy form -> sources still in it (dry-run: what --apply would convert)
    pending: Counter = field(default_factory=Counter)
    converted: Counter = field(default_factory=Counter)
    #: legacy form -> sources the walk could not convert (read-only, fossil)
    unconverted: Counter = field(default_factory=Counter)
    rows: list[RowMove] = field(default_factory=list)
    rows_rewritten: int = 0
    issues: list[Any] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.converted or self.rows_rewritten)


def _db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().db_path)


def _open(db: Path | None = None):
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    return open_sqlite(str(db or _db_path()))


def _pure(raw: str):
    return PureWindowsPath(raw) if len(raw) > 1 and raw[1] == ":" else PurePosixPath(raw)


# ---------------------------------------------------------------------------
# Roots and the store's view of them
# ---------------------------------------------------------------------------


def _project_roots(conn) -> list[Any]:
    """One ``REAL_PROJECT_CWD`` root per project row whose mount is a directory
    the index walk would enter."""
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.roots import is_home_or_ancestor
    from flow_sdk.fs_store.indexer.special_folders import IndexDecision, indexing_decision
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.instance_settings import get_instance_settings

    home = get_instance_settings().user_home
    out: list[Any] = []
    rows = conn.execute(
        "SELECT id, json_extract(data, '$.fs_storage_mount_path') FROM entities WHERE type = 'project'"
    ).fetchall()
    for pid, mount in rows:
        if not mount:
            continue
        path = Path(str(mount))
        if not path.is_dir() or is_home_or_ancestor(path, home):
            continue
        if indexing_decision(path, foreground=False) is not IndexDecision.WALK:
            continue
        out.append(FSRef(path, record_type=RecordType.REAL_PROJECT_CWD, scope="project", project_id=str(pid)))
    return out


def _roots(conn) -> list[Any]:
    from flow_sdk.fs_store.indexer.roots import default_roots

    roots = default_roots()
    seen = {str(r._path) for r in roots}
    for root in _project_roots(conn):
        if str(root._path) not in seen:
            seen.add(str(root._path))
            roots.append(root)
    return roots


def _preload(conn, type_names: set[str]):
    """The walk's ``OwnerPreload`` — live ids and stored paths per type — read
    from the sqlite file directly."""
    from flow_sdk.fs_store.indexer.index_function import OwnerPreload
    from flow_sdk.fs_store.path_owners import PathOwnerIndex

    preload = OwnerPreload()
    for name in type_names:
        rows = conn.execute(
            "SELECT id, json_extract(data, '$.asset_ref') FROM entities WHERE type = ?", (name,)
        ).fetchall()
        preload.ids[name] = {str(r[0]) for r in rows}
        preload.paths[name] = {str(r[0]): str(r[1]) for r in rows if r[1]}
    preload.owners = PathOwnerIndex.from_preload(preload.paths)
    return preload


# ---------------------------------------------------------------------------
# Carriers
# ---------------------------------------------------------------------------


def _legacy_read(info: Any, ref: Any):
    """The ``Found`` a retired reader answered for ``ref``, else None."""
    from flow_sdk.fs_store.identity_carrier import Found

    carrier = info.carrier
    found = carrier.read(carrier.locate(info.layout_for(ref)))
    return found if isinstance(found, Found) and found.legacy else None


async def _scan(roots: list[Any]) -> list[Any]:
    from flow_sdk.fs_store.indexer.builtin import register_default_functions
    from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions

    idx = FSIndexer(roots=list(roots))
    register_default_functions(idx)
    return await idx.scan(IndexerOptions(verbose=False))


def _convert_sources(refs: list[Any], preload: Any, report: Report, *, dry_run: bool) -> None:
    from flow_sdk.fs_store.identity_carrier import MalformedCarrier, UnclaimedPath
    from flow_sdk.fs_store.indexer.index_function import resolve_ref_identity
    from flow_sdk.fs_store.indexer.index_log import MALFORMED_CARRIER, ScanIssue, append_scan_issue, note_legacy_form
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    for ref in refs:
        info = SchemaRegistry.get(str(ref.record_type)) if ref.record_type is not None else None
        if info is None or info.from_disk_fn is None or not info.carrier.writable:
            continue
        report.scanned += 1
        try:
            found = _legacy_read(info, ref)
        except UnclaimedPath:
            continue
        except MalformedCarrier as exc:
            append_scan_issue(ScanIssue(path=str(ref._path), kind=MALFORMED_CARRIER, detail=str(exc), type_name=info.type_name))
            continue
        if found is None:
            continue
        form = found.source
        if dry_run:
            note_legacy_form(ref._path, form, info.type_name)
            report.pending[form] += 1
            continue
        try:
            resolve_ref_identity(info, ref, preload)
            still_legacy = _legacy_read(info, ref) is not None
        except Exception as exc:  # noqa: BLE001 — one bad source must not abort the run
            logger.warning("identity migration: %s at %s not converted: %s", info.type_name, ref._path, exc)
            still_legacy = True
        if still_legacy:
            report.unconverted[form] += 1
        else:
            report.converted[form] += 1


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


def plan_rows(conn) -> list[RowMove]:
    """Every folder-type row whose ``asset_ref`` names the inner main file."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.layout import Folder

    moves: list[RowMove] = []
    for name in SchemaRegistry.get_all_types():
        info = SchemaRegistry.get(name)
        if info is None or not isinstance(info.shape, Folder) or not info.shape.main:
            continue
        rows = conn.execute(
            "SELECT id, json_extract(data, '$.asset_ref') FROM entities WHERE type = ?", (name,)
        ).fetchall()
        for entity_id, raw in rows:
            if not raw:
                continue
            root = info.shape.root_of(_pure(str(raw)))
            if str(root) != str(raw):
                moves.append(RowMove(name, str(entity_id), str(raw), str(root)))
    return moves


def _rewrite_rows(conn, moves: list[RowMove]) -> int:
    done = 0
    for move in moves:
        cur = conn.execute(
            "UPDATE entities SET data = json_set(data, '$.asset_ref', ?) WHERE id = ? AND type = ?",
            (move.new, move.entity_id, move.type_name),
        )
        done += cur.rowcount or 0
    conn.commit()
    return done


# ---------------------------------------------------------------------------
# The migration
# ---------------------------------------------------------------------------


async def migrate(*, dry_run: bool = True, db: Path | None = None, roots: list[Any] | None = None) -> Report:
    """Convert every retired carrier form under ``roots`` (the instance's when
    None) and rewrite every inner-main-file ``asset_ref`` row in ``db``."""
    from flow_sdk.fs_store.indexer import index_log
    from flow_sdk.schema.type_info import register_all

    register_all()
    report = Report()
    started = index_log._now_iso()
    index_log._legacy_noted.clear()   # the report lists every retired form this walk sees
    conn = _open(db)
    try:
        refs = await _scan(list(roots) if roots is not None else _roots(conn))
        types = {str(r.record_type) for r in refs if r.record_type is not None}
        _convert_sources(refs, _preload(conn, types), report, dry_run=dry_run)
        report.rows = plan_rows(conn)
        if report.rows and not dry_run:
            report.rows_rewritten = _rewrite_rows(conn, report.rows)
    finally:
        conn.close()
    report.issues = [
        issue
        for name in (None, *sorted(types))
        for issue in index_log.read_scan_issues(name)
        if issue.at >= started
    ]
    return report


def _print(report: Report, dry_run: bool) -> None:
    forms = report.pending if dry_run else report.converted
    logger.info("scanned %d source(s)", report.scanned)
    logger.info("%s by retired form: %s", "convertible" if dry_run else "converted", json.dumps(dict(forms)) or "{}")
    if report.unconverted:
        logger.info("left in a retired form (read-only or fossil): %s", json.dumps(dict(report.unconverted)))
    logger.info("asset_ref rows at the inner main file: %d%s", len(report.rows), "" if dry_run else f" (rewritten {report.rows_rewritten})")
    for move in report.rows:
        logger.info("  %s %s: %s -> %s", move.type_name, move.entity_id, move.old, move.new)
    if report.issues:
        logger.info("scan issues: %d", len(report.issues))
        for issue in report.issues:
            logger.info("  %s %s %s%s", issue.kind, issue.type_name or "-", issue.path, f" ({issue.detail})" if issue.detail else "")
    if dry_run:
        logger.info("DRY-RUN — nothing was written. Re-run with --apply.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Move every asset id into its live carrier form; unify asset_ref.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Report only (the default).")
    parser.add_argument("--db", default=None, help="Target a specific sqlite file.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")
    try:
        report = asyncio.run(migrate(dry_run=dry_run, db=Path(args.db) if args.db else None))
    except Exception as e:
        logger.exception("identity migration failed: %s", e)
        return 1
    _print(report, dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
