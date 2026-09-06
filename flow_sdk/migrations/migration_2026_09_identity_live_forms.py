"""One-shot migration: every asset id in its live carrier form, every folder
row's ``asset_ref`` at its layout root.

The live forms are ``id:`` in a markdown main document's frontmatter, a
folder's ``.flow/capsules/identity.json`` and the ``"id"`` key of a report's
json root. The retired forms this pass converts — id unchanged — are the
markdown HTML-comment ``identity`` capsule, the ``asset_id:`` frontmatter
key, the ``.flow/id`` line, a json capsule under a markdown main document and
a manifest ``id`` (``dataset.json``, ``deck.json``). The live carriers no
longer read those forms — a source still in one reads as foreign and its
scan issue names this script — so the readers live HERE, and only here.

``asset_ref`` is the folder for every folder type. Rows written while agent,
spec and the report types pointed it at the inner main file
(``<folder>/agent.md``) are rewritten to the folder.

The walk is the production indexer graph over the instance's roots — home,
cwd, the system project and every project row's mount. A retired id moves
into the live carrier unchanged, and only when that carrier is still empty:
a live id always wins. A source the walk cannot write (a read-only root)
stays as it is and is reported.

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
    #: legacy form -> sources the walk could not convert (a read-only root)
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




# ---------------------------------------------------------------------------
# The retired forms — read and converted here only
# ---------------------------------------------------------------------------

_MANIFEST_IDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("dataset.json", ("metadata", "id")),
    ("template.json", ("metadata", "id")),
    ("deck.json", ("id",)),
    ("graph.json", ("id",)),
)


def _valid(value: Any) -> str | None:
    from flow_sdk.api.api_types.identifier import is_valid_entity_id

    return str(value) if is_valid_entity_id(value) else None


def _flow_id(folder: Path) -> str | None:
    """The retired ``<folder>/.flow/id`` line, through the carrier's own reader."""
    from flow_sdk.fs_store.identity_carrier import retired_flow_id

    found = retired_flow_id(folder)
    return _valid(found.raw) if found is not None else None


def _folder_json_id(folder: Path) -> str | None:
    """The folder's identity capsule, read through the LIVE carrier so it is
    held to the same validation (version 1, exactly the ``id`` key): a corrupt
    capsule raises ``MalformedCarrier`` and is reported, never adopted."""
    from flow_sdk.fs_store.identity_carrier import Found, Sidecar

    found = Sidecar().read(folder)
    return found.id if isinstance(found, Found) else None


def _manifest_id(folder: Path) -> str | None:
    for name, keys in _MANIFEST_IDS:
        try:
            node: Any = json.loads((folder / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for key in keys:
            node = node.get(key) if isinstance(node, dict) else None
        if (found := _valid(node)) is not None:
            return found
    return None


def _comment_capsule_id(doc: Path) -> str | None:
    """The retired HTML-comment ``identity`` capsule of a markdown document."""
    from flow_sdk.capsules import AssetCapsule

    data = AssetCapsule.from_path(doc).read("identity")
    return _valid(data.data.get("id")) if data is not None else None


#: The retired source the CARRIER named -> (this report's form, its reader).
#: Precedence is the carrier's; re-deciding it here is how the two drift.
_RETIRED_FORMS: dict[str, tuple[str, Any]] = {
    "asset_id": ("frontmatter_asset_id", lambda where: _valid(_read_frontmatter(where).get("asset_id"))),
    "capsule": ("capsule", _comment_capsule_id),
    "flow-id": ("folder_capsule_id", lambda where: _flow_id(where if where.is_dir() else where.parent)),
}


def _read_frontmatter(doc: Path) -> dict:
    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load

    try:
        header = _extract_frontmatter(doc.read_text(encoding="utf-8"))
    except OSError:
        return {}
    return (_yaml_load(header) or {}) if header else {}


def _retired_read(info: Any, ref: Any) -> tuple[str, str] | None:
    """``(form, id)`` when the source carries its id only in a retired form.

    The CARRIER decides: its read already tells a live id from a retired one,
    so this only maps that verdict to a reader. The two forms it does not look
    at — a folder capsule beside a markdown main document, a manifest id — are
    asked afterwards, when the carrier came back empty."""
    from flow_sdk.fs_store.identity_carrier import RETIRED, Foreign, Found, Frontmatter, Sidecar

    carrier = info.carrier
    where = carrier.locate(info.layout_for(ref))
    found = carrier.read(where)
    if isinstance(found, Found):
        return None   # already live
    if isinstance(found, Foreign) and found.source.startswith(RETIRED):
        form = _RETIRED_FORMS.get(found.source[len(RETIRED):])
        if form is not None and (entity_id := form[1](where)) is not None:
            return form[0], entity_id
        return None
    if isinstance(carrier, Frontmatter):
        if (found_id := _folder_json_id(where.parent)) is not None:
            return "folder-json", found_id
    elif isinstance(carrier, Sidecar) and (found_id := _manifest_id(where)) is not None:
        return "manifest_id", found_id
    return None


def _convert(info: Any, ref: Any, form: str, entity_id: str) -> None:
    """Move ``entity_id`` into the live carrier — same id, retired bytes gone.
    A manifest keeps its ``id`` key: it is the asset's document, not a carrier."""
    from flow_sdk.capsules import CapsuleData, strip_capsule_blocks
    from flow_sdk.capsules.folder import FolderCapsule
    from flow_sdk.fs_store.identity_carrier import Frontmatter
    from flow_sdk.fs_store.indexer._frontmatter import _atomic_write_text, merge_frontmatter

    carrier = info.carrier
    where = carrier.locate(info.layout_for(ref))
    if isinstance(carrier, Frontmatter):
        text = where.read_text(encoding="utf-8")
        merged = merge_frontmatter(
            strip_capsule_blocks(text, names={"identity"}), {"id": entity_id}, drop_keys=("asset_id",), prepend=True
        )
        if merged != text:
            _atomic_write_text(where, merged)
        folder = where.parent
        if form == "folder-json":
            FolderCapsule(folder).remove("identity")
    else:
        folder = where
        FolderCapsule(folder).write_if_absent("identity", CapsuleData(version=1, data={"id": entity_id}))
    flow_id = folder / ".flow" / "id"
    if flow_id.is_file() and flow_id.read_text(encoding="utf-8").strip() == entity_id:
        flow_id.unlink()


async def _scan(roots: list[Any]) -> list[Any]:
    from flow_sdk.fs_store.indexer.builtin import register_default_functions
    from flow_sdk.fs_store.indexer.index_function import FSIndexer, IndexerOptions

    idx = FSIndexer(roots=list(roots))
    register_default_functions(idx)
    return await idx.scan(IndexerOptions(verbose=False))


def _convert_sources(refs: list[Any], report: Report, *, dry_run: bool) -> None:
    from flow_sdk.fs_store.identity_carrier import UnclaimedPath
    from flow_sdk.fs_store.indexer.index_log import MALFORMED_CARRIER, ScanIssue, append_scan_issue
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    for ref in refs:
        info = SchemaRegistry.get(str(ref.record_type)) if ref.record_type is not None else None
        if info is None or info.from_disk_fn is None or not info.carrier.writable:
            continue
        report.scanned += 1
        try:
            retired = _retired_read(info, ref)
        except UnclaimedPath:
            continue
        except Exception as exc:  # noqa: BLE001 — a malformed carrier or a broken source must not abort the run
            append_scan_issue(ScanIssue(path=str(ref._path), kind=MALFORMED_CARRIER, detail=str(exc), type_name=info.type_name))
            continue
        if retired is None:
            continue
        form, entity_id = retired
        if dry_run:
            report.pending[form] += 1
            continue
        if getattr(ref, "read_only", False):
            report.unconverted[form] += 1
            continue
        try:
            _convert(info, ref, form, entity_id)
            still_retired = _retired_read(info, ref) is not None
        except Exception as exc:  # noqa: BLE001
            logger.warning("identity migration: %s at %s not converted: %s", info.type_name, ref._path, exc)
            still_retired = True
        (report.unconverted if still_retired else report.converted)[form] += 1


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
    conn = _open(db)
    try:
        refs = await _scan(list(roots) if roots is not None else _roots(conn))
        types = {str(r.record_type) for r in refs if r.record_type is not None}
        _convert_sources(refs, report, dry_run=dry_run)
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
