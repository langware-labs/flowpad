"""One-shot migration: collapse `data_source_spec` rows onto their name-keyed id.

Until FLOWPAD-2070 the type declared a derived identity carrier and NO stable
key, so the id seam fell through to `uuid5(resolved path)`. A spec
ships inside the wheel, so that path names the INSTALL, not the asset:

    …/AppData/Roaming/uv/tools/flowpad/Lib/site-packages/flow_sdk/…/rss
    …/AppData/Local/Python/pythoncore-3.14-64/Lib/site-packages/flow_sdk/…/rss
    …/AppData/Local/uv/cache/archive-v0/<hash>/Lib/site-packages/flow_sdk/…/rss

Three coexisting locations for one shipped source on one machine, each minting
its own id, none of them ever reaped — the provider picker rendered one button
per row. Now that identity is keyed on `name`, the next index mints ONE id per
spec; without this pass those new rows would land ON TOP of the old ones and the
list would get longer, not shorter.

Per name, keep exactly one row at the name-keyed id:

  * a row already at that id wins outright;
  * otherwise the best surviving row is RE-KEYED to it, so the picker is never
    briefly empty and `asset_ref` stays pointed at real bytes;
  * every other row for that name is deleted.

Survivor ranking, first non-tie wins:

  1. `asset_ref` that still exists on disk — the live install's row
  2. oldest `created_date` — matches the tie-break the indexer's own
     `PathOwnerIndex` uses, so both converge on the same row
  3. lexicographic id

Nothing user-owned pins a spec id, which is what makes the re-key safe: a
configured `DataSource` resolves its definition by NAME
(`DataSourceSpec.get_one({"name": provider})`), the driver registry is a flat
dict keyed by name, and a nested editor webapp's parent typeid is re-derived
from the folder chain on the next index. Content is re-read from disk anyway.

Idempotent: a clean instance reports zero changes, and re-running after a
successful pass is a no-op.

Usage:
    uv run -m flow_sdk.migrations.migration_2026_09_data_source_spec_name_identity --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_data_source_spec_name_identity --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger("migrate.data_source_spec_name_identity")

TYPE_NAME = "data_source_spec"


@dataclass
class Group:
    """One spec name claimed by one or more rows."""

    name: str
    target_id: str
    winner: str
    losers: list[str] = field(default_factory=list)
    rekeyed: bool = False
    reason: str = ""


@dataclass
class Report:
    groups: list[Group] = field(default_factory=list)
    rows_rekeyed: int = 0
    rows_deleted: int = 0

    @property
    def forked_names(self) -> int:
        return sum(1 for g in self.groups if g.losers)


def _db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().db_path)


def _open(db: Path | None = None):
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    return open_sqlite(str(db or _db_path()))


def _has_table(conn, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
    ).fetchone() is not None


def _scan(conn) -> dict[str, list[dict[str, Any]]]:
    """``{name: [row, ...]}`` for every spec row that names itself."""
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    # A fresh instance runs migrations before the server ever created its schema.
    if not _has_table(conn, "entities"):
        return {}
    cur = conn.execute(
        "SELECT id, data, created_date FROM entities WHERE type = ?", (TYPE_NAME,)
    )
    for eid, blob, created in cur:
        try:
            data = json.loads(blob) if blob else {}
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        name = str(data.get("name") or "").strip()
        if not name:
            continue
        groups[name].append(
            {
                "id": str(eid),
                "name": name,
                "asset_ref": str(data.get("asset_ref") or ""),
                "created_date": created or "",
            }
        )
    return dict(groups)


def _target_id(name: str, rows: list[dict[str, Any]]) -> str:
    """The id the fixed minter now produces for this spec.

    Resolved through `reconcile` over the type's carrier against a folder that
    still exists — the one sanctioned id seam, so this can never drift from what the
    next index writes. Falls back to the same key text when every path is gone.
    """
    import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — populate the registry
    from flow_sdk.api.api_types.identifier import mint_uuid
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.reconcile import reconcile
    from flow_sdk.fs_store.record_types import RecordType
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    info = SchemaRegistry.get(TYPE_NAME)
    if info is not None:
        for row in rows:
            ref = row["asset_ref"]
            if ref and Path(ref).is_dir():
                try:
                    probe = FSRef(Path(ref), record_type=RecordType(TYPE_NAME), scope="system")
                    return reconcile(info, info.layout_for(probe), None, None, write=True, ref=probe)
                except Exception:  # noqa: BLE001 — a bad ref must not stop the pass
                    logger.debug("mint via %s failed", ref, exc_info=True)
    namespace = getattr(info, "id_namespace", None)
    key = f"{TYPE_NAME}:{name}"
    return mint_uuid(key, namespace=namespace) if namespace else mint_uuid(key)


def _rank(rows: list[dict[str, Any]]) -> tuple[str, str]:
    """``(winner_id, reason)`` — see the module docstring's ranking."""
    on_disk = [r for r in rows if r["asset_ref"] and Path(r["asset_ref"]).is_dir()]
    if len(on_disk) == 1:
        return on_disk[0]["id"], "only ref still on disk"
    contenders = on_disk or rows
    ranked = sorted(contenders, key=lambda r: (str(r["created_date"] or "~"), r["id"]))
    return ranked[0]["id"], "oldest created_date"


def plan(conn) -> list[Group]:
    """Group spec rows by name and choose the survivor for each. Read-only."""
    out: list[Group] = []
    for name, rows in sorted(_scan(conn).items()):
        target = _target_id(name, rows)
        ids = {r["id"] for r in rows}
        if target in ids:
            winner, reason = target, "already at the name-keyed id"
        else:
            winner, reason = _rank(rows)
        group = Group(
            name=name,
            target_id=target,
            winner=winner,
            losers=sorted(ids - {winner}),
            rekeyed=winner != target,
            reason=reason,
        )
        if group.losers or group.rekeyed:
            out.append(group)
    return out


def _apply(conn, groups: list[Group], report: Report) -> None:
    """Delete losers first, then re-key — so the winner's new id can never
    collide with a loser that has not been removed yet."""
    for group in groups:
        for loser in group.losers:
            conn.execute("DELETE FROM entities WHERE id = ?", (loser,))
            conn.execute("DELETE FROM relationships WHERE from_id = ? OR to_id = ?", (loser, loser))
            report.rows_deleted += 1
        if group.rekeyed:
            conn.execute(
                "UPDATE entities SET id = ? WHERE id = ?", (group.target_id, group.winner)
            )
            report.rows_rekeyed += 1
    conn.commit()


def collapse(dry_run: bool = True, db: Path | None = None) -> Report:
    """Entry point. ``dry_run=True`` plans without writing."""
    conn = _open(db)
    try:
        report = Report(groups=plan(conn))
        if not dry_run:
            _apply(conn, report.groups, report)
        return report
    finally:
        conn.close()


def _print(report: Report, dry_run: bool) -> None:
    verb = "would collapse" if dry_run else "collapsed"
    if not report.groups:
        print("data source specs: one row per name already.")  # noqa: T201
        return
    print(  # noqa: T201
        f"data source specs: {verb} {report.forked_names} forked name(s) "
        f"across {len(report.groups)} spec(s)."
    )
    for group in report.groups:
        detail = f"{len(group.losers)} duplicate(s)" if group.losers else "re-key only"
        print(f"  {group.name}: {detail} — kept {group.winner[:8]} ({group.reason})")  # noqa: T201


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    dry_run = not args.apply
    report = collapse(dry_run=dry_run)
    _print(report, dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
