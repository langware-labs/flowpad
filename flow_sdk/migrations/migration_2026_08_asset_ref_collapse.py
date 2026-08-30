"""One-shot migration: collapse forked assets back to one row per path.

``asset_ref`` is globally unique — one entity per file path across all types
(``Entity.get_by_asset_ref``). Until the owner-first identity fix, that
invariant was assumed by every path→entity lookup but enforced by nothing:
an asset's id lives in the source as a capsule, a full-content rewrite (what
an agent does on every revision) wiped it, and the next index resolved
identity from the file alone and minted a FRESH id — forking the entity.

Two kinds of damage are left behind, and this migration repairs both:

* **Forked paths** — several live rows claiming one file. "Which entity is
  this document?" then has more than one answer, and which one a lookup
  returns depends on registry iteration order.
* **Dangling references** — bookmarks, ``context_data.last_shown``,
  ``display_stack``, ``private_context_entities_`` and relationships pinned
  to a row the same-path sweep already reaped. Those render as
  "Missing asset" even though the file is right there on disk.

Survivor ranking, first non-tie wins:

  1. most inbound references — the row everything already points at IS the
     identity; protecting references is the whole point
  2. the id the file itself still carries, if it names a candidate
  3. newest ``updated_date`` — real edit history
  4. oldest ``created_date`` — matches the ``type_uname`` dedupe rule and
     ``PathOwnerIndex``'s own tie-break, so the indexer and this migration
     converge on the SAME row
  5. lexicographic id

Deliberately NOT ``resolve_asset_collisions``: that ranks *paths for one id*
(a copy), and has no opinion about which of several *ids* is real.

Order matters — references are repointed BEFORE losers are deleted, so an
interrupted run leaves pointers aimed at a live row rather than a dead one.

Idempotent: a clean DB yields zero groups, and re-running after a successful
pass is a no-op.

Usage:
    uv run -m flow_sdk.migrations.migration_2026_08_asset_ref_collapse --dry-run
    uv run -m flow_sdk.migrations.migration_2026_08_asset_ref_collapse --apply
"""

from __future__ import annotations

import argparse
import asyncio
import functools
import json
import logging
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("migrate.asset_ref_collapse")

#: A uuid is 36 chars of hex and dashes — long enough that a blind substring
#: rewrite over a JSON blob cannot collide with unrelated content, and short
#: enough to appear in every embedding form we care about (`<type>-<id>` and
#: the bare id) in one pass.
_UUID_LEN = 36


@dataclass
class Group:
    """One path claimed by more than one live row."""

    type_name: str
    path: str
    winner: str
    losers: list[str]
    reason: str


@dataclass
class Dangling:
    """A reference whose target row is gone, but whose PATH is recoverable."""

    holder_id: str
    holder_type: str
    dead_id: str
    path: str
    live_id: str


@dataclass
class Report:
    groups: list[Group] = field(default_factory=list)
    dangling: list[Dangling] = field(default_factory=list)
    rows_repointed: dict[str, int] = field(default_factory=dict)
    relationships_repointed: int = 0
    rows_deleted: int = 0
    files_restamped: int = 0

    @property
    def forked_paths(self) -> int:
        return len(self.groups)

    @property
    def losing_rows(self) -> int:
        return sum(len(g.losers) for g in self.groups)


def _db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().db_path)


def _open(db: Path | None = None):
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    return open_sqlite(str(db or _db_path()))


@functools.lru_cache(maxsize=None)
def _canon_cached(path: str) -> str:
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    try:
        return canonical_posix_path(path)
    except (OSError, ValueError):
        return str(path)


def _non_owner_types() -> frozenset[str]:
    """Types that merely reference a path (``Artifact``) — never a survivor."""
    from flow_sdk.fs_store.path_owners import _non_owner_types as impl

    return impl()


def _canon(path: str) -> str:
    """Canonical path, memoized — this resolves symlinks (a realpath syscall
    chain) and the same handful of paths recur across every row and every
    pinned reference in the scan."""
    return _canon_cached(str(path))


def _scan(conn) -> dict[tuple[str, str], list[dict[str, Any]]]:
    """``{(type, canonical_path): [row, ...]}`` for every path-bearing row."""
    excluded = _non_owner_types()
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    cur = conn.execute(
        "SELECT id, type, data, created_date, updated_date FROM entities "
        "WHERE json_extract(data, '$.asset_ref') IS NOT NULL"
    )
    for eid, type_name, blob, created, updated in cur:
        if type_name in excluded:
            continue
        try:
            data = json.loads(blob) if blob else {}
        except (TypeError, json.JSONDecodeError):
            continue
        raw = data.get("asset_ref")
        if not raw:
            continue
        groups[(type_name, _canon(str(raw)))].append(
            {
                "id": str(eid),
                "type": type_name,
                "asset_ref": str(raw),
                "created_date": created or "",
                "updated_date": updated or "",
            }
        )
    return {k: v for k, v in groups.items() if len(v) > 1}


def _reference_counts(conn, ids: list[str]) -> dict[str, int]:
    """How many OTHER rows / relationships mention each id."""
    counts = {i: 0 for i in ids}
    for eid in ids:
        try:
            row = conn.execute(
                "SELECT COUNT(*) FROM entities WHERE id != ? AND data LIKE ?",
                (eid, f"%{eid}%"),
            ).fetchone()
            counts[eid] += int(row[0] or 0)
        except Exception:
            pass
        try:
            row = conn.execute(
                "SELECT COUNT(*) FROM relationships WHERE from_id = ? OR to_id = ?",
                (eid, eid),
            ).fetchone()
            counts[eid] += int(row[0] or 0)
        except Exception:
            pass
    return counts


def _carrier_id(type_name: str, path: str) -> str | None:
    """The id the source file itself still carries, if any."""
    try:
        from flow_sdk.fs_store.fs_ref import FSRef
        from flow_sdk.fs_store.record_types import RecordType
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        info = SchemaRegistry.get(type_name)
        if info is None or not Path(path).exists():
            return None
        return info.read_id(FSRef(Path(path), record_type=RecordType(type_name)))
    except Exception:
        return None


def _rank(conn, type_name: str, path: str, rows: list[dict[str, Any]]) -> tuple[str, str]:
    """Return ``(winner_id, reason)``."""
    ids = [r["id"] for r in rows]
    by_id = {r["id"]: r for r in rows}

    refs = _reference_counts(conn, ids)
    best_refs = max(refs.values()) if refs else 0
    if best_refs > 0:
        contenders = [i for i in ids if refs[i] == best_refs]
        if len(contenders) == 1:
            return contenders[0], f"most-referenced ({best_refs})"
    else:
        contenders = list(ids)

    carrier = _carrier_id(type_name, path)
    if carrier and carrier in contenders:
        return carrier, "carried by the file"

    with_updated = sorted(contenders, key=lambda i: str(by_id[i]["updated_date"]), reverse=True)
    newest = str(by_id[with_updated[0]]["updated_date"])
    if newest and sum(1 for i in contenders if str(by_id[i]["updated_date"]) == newest) == 1:
        return with_updated[0], "newest updated_date"

    # Oldest created_date, then lexicographic — the SAME tie-break
    # ``PathOwnerIndex`` uses, so the indexer picks this row too.
    ranked = sorted(contenders, key=lambda i: (str(by_id[i]["created_date"] or "~"), i))
    return ranked[0], "oldest created_date"


def plan(conn) -> list[Group]:
    """Group forked paths and choose a survivor for each. Read-only."""
    out: list[Group] = []
    for (type_name, path), rows in sorted(_scan(conn).items()):
        winner, reason = _rank(conn, type_name, path, rows)
        losers = sorted(r["id"] for r in rows if r["id"] != winner)
        out.append(Group(type_name=type_name, path=path, winner=winner, losers=losers, reason=reason))
    return out


def _owners_by_path(conn) -> dict[str, str]:
    """``{canonical_path: live_id}`` for every path claimed by exactly one row."""
    excluded = _non_owner_types()
    claims: dict[str, set[str]] = defaultdict(set)
    for eid, type_name, blob in conn.execute(
        "SELECT id, type, data FROM entities WHERE json_extract(data, '$.asset_ref') IS NOT NULL"
    ):
        if type_name in excluded:
            continue
        try:
            raw = (json.loads(blob) if blob else {}).get("asset_ref")
        except (TypeError, json.JSONDecodeError):
            continue
        if raw:
            claims[_canon(str(raw))].add(str(eid))
    return {path: next(iter(ids)) for path, ids in claims.items() if len(ids) == 1}


def _iter_path_pinned_refs(data: Any):
    """Yield ``(dead_id_candidate, path)`` pairs a reference carries alongside its id.

    Only shapes that store BOTH an id and the path it came from are healable —
    guessing the target of a bare id would be worse than leaving it broken.
    Covers the display pins (``last_shown``, ``display_stack``) and the
    auto-bookmark shape (``data.entity_id`` + ``data.nav.asset_ref``).
    """
    if isinstance(data, dict):
        entity_id = data.get("id") or data.get("entity_id")
        path = data.get("path")
        if not path:
            nav = data.get("nav")
            if isinstance(nav, dict):
                path = nav.get("asset_ref")
        if entity_id and path and isinstance(entity_id, str) and isinstance(path, str):
            # Both forms occur in the wild for the same field: a bare uuid and
            # a `<type>-<uuid>` typeid. Normalize to the uuid — the rewrite is a
            # substring replace, so it repairs either spelling.
            yield entity_id[-_UUID_LEN:] if len(entity_id) > _UUID_LEN else entity_id, path
        for value in data.values():
            yield from _iter_path_pinned_refs(value)
    elif isinstance(data, list):
        for item in data:
            yield from _iter_path_pinned_refs(item)


def plan_dangling(conn) -> list[Dangling]:
    """References pinned to a dead id whose path still resolves to a live row.

    This is the damage the user actually sees. A reaped row leaves bookmarks
    and display pins aimed at an id that no longer exists, and the editor
    renders "Missing asset" over a file that is right there on disk. These
    references are NOT part of any fork group — their target is already gone —
    so the collapse above never reaches them.
    """
    live_ids = {str(r[0]) for r in conn.execute("SELECT id FROM entities")}
    owners = _owners_by_path(conn)
    out: list[Dangling] = []
    for eid, type_name, blob in conn.execute("SELECT id, type, data FROM entities"):
        try:
            data = json.loads(blob) if blob else {}
        except (TypeError, json.JSONDecodeError):
            continue
        seen: set[str] = set()
        for dead_id, path in _iter_path_pinned_refs(data):
            if dead_id in live_ids or dead_id in seen or len(dead_id) != _UUID_LEN:
                continue
            live = owners.get(_canon(path))
            if not live:
                continue
            seen.add(dead_id)
            out.append(
                Dangling(
                    holder_id=str(eid),
                    holder_type=str(type_name),
                    dead_id=dead_id,
                    path=path,
                    live_id=live,
                )
            )
    return out


def _heal_dangling(conn, dangling: list[Dangling], report: Report) -> None:
    for d in dangling:
        cur = conn.execute(
            "UPDATE entities SET data = replace(data, ?, ?) WHERE id = ?",
            (d.dead_id, d.live_id, d.holder_id),
        )
        if cur.rowcount:
            report.rows_repointed[d.holder_type] = report.rows_repointed.get(d.holder_type, 0) + cur.rowcount


def _repoint(conn, groups: list[Group], report: Report) -> None:
    """Aim every reference at the survivor BEFORE any row is deleted."""
    for group in groups:
        for loser in group.losers:
            if len(loser) != _UUID_LEN:
                logger.warning("skipping repoint of non-uuid id %r", loser)
                continue
            try:
                cur = conn.execute(
                    "UPDATE relationships SET from_id = ? WHERE from_id = ?", (group.winner, loser)
                )
                report.relationships_repointed += cur.rowcount or 0
                cur = conn.execute(
                    "UPDATE relationships SET to_id = ? WHERE to_id = ?", (group.winner, loser)
                )
                report.relationships_repointed += cur.rowcount or 0
            except Exception as e:
                logger.warning("relationship repoint failed for %s: %s", loser, e)

            # One blind substring rewrite catches every embedding form at once:
            # `<type>-<id>` typeids, bare ids, and ids nested anywhere in the
            # JSON (bookmark.data, last_shown, display_stack, tab pointers).
            # Identify the holders first so the report can attribute them per
            # type; the rewrite then targets those ids by primary key.
            holders = conn.execute(
                "SELECT id, type FROM entities WHERE id != ? AND data LIKE ?",
                (loser, f"%{loser}%"),
            ).fetchall()
            for holder_id, holder_type in holders:
                cur = conn.execute(
                    "UPDATE entities SET data = replace(data, ?, ?) WHERE id = ?",
                    (loser, group.winner, holder_id),
                )
                if cur.rowcount:
                    report.rows_repointed[holder_type] = (
                        report.rows_repointed.get(holder_type, 0) + cur.rowcount
                    )


async def _delete_losers(conn, groups: list[Group], report: Report, *, use_driver: bool) -> None:
    """Remove losing rows, taking FTS entries and record dirs with them.

    The row itself is always deleted on ``conn`` — that is the connection the
    caller opened, so ``--db`` targets the DB it was pointed at rather than
    silently operating on the configured instance. The driver-side cleanup
    (FTS index, wiki edges, shadow records dir) only applies to the live
    instance, so it is skipped when a foreign DB is targeted; the same
    minimal, type-scoped removal the orphan sweep uses, for the same reason —
    a full ``Entity.delete()`` cascade can ripple into bootstrap rows.
    """
    import shutil

    driver = None
    shadow_dir_for = None
    if use_driver:
        from flow_sdk.db import get_db_driver
        from flow_sdk.fs_store.record_paths import shadow_dir_for as _shadow

        driver = get_db_driver()
        shadow_dir_for = _shadow

    for group in groups:
        for loser in group.losers:
            if use_driver:
                try:
                    from flow_sdk import wiki

                    await wiki.delete_for_id(group.type_name, loser)
                except Exception:
                    pass
                if driver is not None and hasattr(driver, "fts_delete"):
                    try:
                        await driver.fts_delete(loser)
                    except Exception:
                        pass
            try:
                cur = conn.execute(
                    "DELETE FROM entities WHERE id = ? AND type = ?", (loser, group.type_name)
                )
                report.rows_deleted += cur.rowcount or 0
            except Exception as e:
                logger.warning("delete failed for %s/%s: %s", group.type_name, loser, e)
            if use_driver and shadow_dir_for is not None:
                try:
                    rec_dir = shadow_dir_for(group.type_name, loser)
                    if rec_dir.exists():
                        await asyncio.to_thread(shutil.rmtree, rec_dir, ignore_errors=True)
                except Exception:
                    pass


def _restamp(groups: list[Group], report: Report) -> None:
    """Heal each survivor's file so the next index agrees without the DB.

    Only ever writes when the carrier is ABSENT (``resolve_id``'s own rule), so
    an invalid or merely stale carrier keeps its bytes. Callers must skip this
    entirely when operating on a DB other than the live instance's — the rows
    are a copy, but the files on disk are not.
    """
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    for group in groups:
        info = SchemaRegistry.get(group.type_name)
        if info is None or not Path(group.path).exists():
            continue
        try:
            ref = FSRef(Path(group.path), record_type=RecordType(group.type_name))
            resolved = info.mint_entity_id(
                ref, owner_id=group.winner, live_ids={group.winner}
            )
            if resolved == group.winner:
                report.files_restamped += 1
        except Exception as e:
            logger.debug("restamp skipped for %s: %s", group.path, e)


async def collapse(*, dry_run: bool = True, db: Path | None = None) -> Report:
    """Collapse every forked path. Returns a :class:`Report`."""
    from flow_sdk.schema.type_info import register_all

    register_all()

    report = Report()
    use_driver = db is None or Path(db) == _db_path()
    conn = _open(db)
    try:
        report.groups = plan(conn)
        if dry_run:
            # Dangling refs are planned against the CURRENT rows; after a real
            # collapse the losers are gone, so it is re-planned below.
            report.dangling = plan_dangling(conn)
            return report

        if report.groups:
            # Repoint BEFORE deleting: an interrupted run then leaves pointers
            # aimed at a live row rather than a dead one.
            _repoint(conn, report.groups, report)
            conn.commit()
            await _delete_losers(conn, report.groups, report, use_driver=use_driver)
            conn.commit()

        # Second pass, AFTER the collapse: heal references whose target was
        # reaped before this migration ever ran — the bookmarks and display
        # pins that render "Missing asset" over a file that still exists.
        report.dangling = plan_dangling(conn)
        if report.dangling:
            _heal_dangling(conn, report.dangling, report)
            conn.commit()
    finally:
        conn.close()

    # Files are shared by every DB that points at them, so a run targeting a
    # copy (``--db``) must stay read-only on disk — it repairs rows, not bytes.
    if report.groups and use_driver:
        _restamp(report.groups, report)
    return report


def _print(report: Report, dry_run: bool) -> None:
    if not report.groups and not report.dangling:
        logger.info("asset_ref collapse: nothing forked, no dangling references.")
        return
    if report.groups:
        logger.info(
            "asset_ref collapse: %d forked path(s), %d losing row(s)",
            report.forked_paths,
            report.losing_rows,
        )
        for g in report.groups:
            logger.info("  %s %s", g.type_name, g.path)
            logger.info("    keep   %s  (%s)", g.winner, g.reason)
            for loser in g.losers:
                logger.info("    drop   %s", loser)
    if report.dangling:
        logger.info("dangling references healed by path: %d", len(report.dangling))
        for d in report.dangling:
            logger.info("  %s/%s: %s -> %s", d.holder_type, d.holder_id, d.dead_id, d.live_id)
            logger.info("    via %s", d.path)
    if dry_run:
        logger.info("DRY-RUN — nothing was written. Re-run with --apply.")
        return
    logger.info(
        "repointed %d relationship(s) and %s; deleted %d row(s); restamped %d file(s)",
        report.relationships_repointed,
        json.dumps(report.rows_repointed) if report.rows_repointed else "0 entity row(s)",
        report.rows_deleted,
        report.files_restamped,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Collapse forked asset rows to one per path.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--db", default=None, help="Target a specific sqlite file.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")
    try:
        report = asyncio.run(collapse(dry_run=dry_run, db=Path(args.db) if args.db else None))
    except Exception as e:
        logger.exception("asset_ref collapse failed: %s", e)
        return 1
    _print(report, dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
