"""Remove desktop-local Docker compute nodes (``@docker-<name>``, provider ``docker``).

The desktop used to register containers as its own ComputeNodes served through
``/api/v1/compute/ws``. That path is gone: containers are enrolled into the hub
with ``flow connect --docker <container>`` and never exist as local rows. Rows
left behind would hydrate with an unknown provider (tolerated as ``None``) and
show up as dead machines, so they are deleted together with their relationships.

Entry point: ``drop(dry_run)``. Idempotent — a clean instance reports zero rows.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

LEGACY_PROVIDER = "docker"
LEGACY_UNAME_PREFIX = "docker-"


@dataclass
class DropReport:
    rows: list[dict[str, Any]] = field(default_factory=list)
    rows_deleted: int = 0
    relationships_deleted: int = 0


def _db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().db_path)


def _open(db: Path | None = None):
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    return open_sqlite(str(db or _db_path()))


def is_legacy_docker_row(data: dict[str, Any]) -> bool:
    if data.get("node_provider_type") == LEGACY_PROVIDER:
        return True
    uname = data.get("uname") or ""
    return isinstance(uname, str) and uname.startswith(LEGACY_UNAME_PREFIX)


def _has_table(conn, name: str) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone()
    return row is not None


def find_legacy_rows(conn) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    # A fresh instance runs migrations before the server ever created its schema.
    if not _has_table(conn, "entities"):
        return rows
    cur = conn.execute("SELECT id, data FROM entities WHERE type = 'compute_node'")
    for eid, blob in cur:
        try:
            data = json.loads(blob) if blob else {}
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and is_legacy_docker_row(data):
            rows.append({"id": str(eid), "name": data.get("name") or data.get("uname") or ""})
    return rows


def drop(dry_run: bool = False, db: Path | None = None) -> DropReport:
    report = DropReport()
    conn = _open(db)
    try:
        report.rows = find_legacy_rows(conn)
        if dry_run or not report.rows:
            return report
        has_relationships = _has_table(conn, "relationships")
        for row in report.rows:
            if has_relationships:
                cur = conn.execute("DELETE FROM relationships WHERE from_id = ? OR to_id = ?", (row["id"], row["id"]))
                report.relationships_deleted += cur.rowcount or 0
            cur = conn.execute("DELETE FROM entities WHERE id = ? AND type = 'compute_node'", (row["id"],))
            report.rows_deleted += cur.rowcount or 0
        conn.commit()
        logger.info(
            "dropped %d legacy docker compute node(s), %d relationship(s)",
            report.rows_deleted,
            report.relationships_deleted,
        )
        return report
    finally:
        conn.close()
