"""Boot lift: mirror the context that predates ``context`` relationship rows.

The driver's save keeps an entity's context rows in step from now on
(``db/drivers/sqlite/context_mirror.py``), but an entity nobody saves again would never get
its rows, and nothing could list it from the other side. This pass reads every stored
entity once and writes the rows its context is missing.

No entry recorded when it was made, so a back-filled row's time is an estimate — the later of
the two entities' creation, never after the holder's last update — and says so
(``backfilled``). Runs once per set of context declarations: a marker beside the database records what was
mirrored and skips the scan on later boots, until a type declares a new context field.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.db.drivers.sqlite.context_mirror import CONTEXT_TYPE, context_entries

MARKER = "context_relationships.backfilled"


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)  # one summary line when rows were (or would be) written
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        out = [f"context relationships: {'would write' if self.dry_run else 'wrote'} {line}" for line in self.moved]
        if self.failed:
            out.append("context relationships: skipped " + ", ".join(self.failed[:10]))
        return out


def _declared(entity_type: str) -> dict[str, str]:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    return getattr(SchemaRegistry.get_entity_cls(entity_type), "context_fields", None) or {}


def _backfill(path: Path, report: Report) -> None:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    dry_run = report.dry_run
    conn = open_sqlite(str(path), mode="ro" if dry_run else "rw")
    try:
        have = set()
        for row in conn.execute("SELECT from_id, to_type, to_id, data FROM relationships WHERE type = ?", (CONTEXT_TYPE,)):
            have.add((row["from_id"], row["to_type"], row["to_id"], (json.loads(row["data"]) if row["data"] else {}).get("kind", "")))
        # Every row is read, but ``context_entries`` parses only the ones that hold context.
        missing, holders = [], 0
        for row in conn.execute("SELECT type, id, created_by, created_date, updated_date, data FROM entities"):
            try:
                entries = context_entries(row["data"], _declared(row["type"]))
            except Exception as e:  # noqa: BLE001 — one bad row never stops the pass
                report.failed.append(f"{row['id'][:8]} ({e})")
                continue
            found = [(row, key, role) for key, role in entries.items() if key[1] != row["id"] and (row["id"], *key) not in have]
            holders += bool(found)
            missing.extend(found)
        if not missing:
            return
        report.moved.append(f"{len(missing)} row(s) for {holders} entit(ies)")
        if dry_run:
            return
        targets = sorted({key[1] for _row, key, _role in missing})
        born: dict[str, str] = {}
        for start in range(0, len(targets), 500):
            chunk = targets[start : start + 500]
            marks = ",".join("?" * len(chunk))
            born.update(conn.execute(f"SELECT id, created_date FROM entities WHERE id IN ({marks})", chunk).fetchall())
        rows = []
        for row, (to_type, to_id, kind), role in missing:
            when = max(filter(None, (row["created_date"], born.get(to_id))), default=None)
            if when and row["updated_date"] and when > row["updated_date"]:
                when = row["updated_date"]
            rows.append((
                mint_uuid(), CONTEXT_TYPE, row["id"], row["type"], to_id, to_type, row["created_by"], when,
                row["created_by"], when, json.dumps({"kind": kind, "role": role, "backfilled": True}),
            ))
        with conn:
            conn.executemany(
                "INSERT INTO relationships (id, type, from_id, from_type, to_id, to_type, created_by, created_date, "
                "updated_by, updated_date, is_child, is_final, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
                rows,
            )
    finally:
        conn.close()


def _declarations() -> str:
    """Everything that counts as context today, as one line: the marker records it, so a field
    declared later (a new ``context_fields`` entry) makes the pass run again for it."""
    from flow_sdk.db.drivers.sqlite.context_mirror import CONTEXT_LISTS  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    declared = {
        f"{cls.get_type()}.{field}={kind}"
        for cls in SchemaRegistry.get_all_entity_classes()
        for field, kind in (getattr(cls, "context_fields", None) or {}).items()
    }
    return ",".join([*CONTEXT_LISTS, *sorted(declared)])


async def lift(*, dry_run: bool = True, db_path: str | None = None) -> Report:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    path = Path(db_path or str(get_instance_settings().db_path))
    marker = path.parent / MARKER
    report = Report(dry_run=dry_run)
    declarations = _declarations()
    if marker.exists() and marker.read_text().strip() == declarations:
        return report
    await asyncio.to_thread(_backfill, path, report)  # a full scan: off the event loop
    if not dry_run:
        marker.write_text(declarations + "\n")
    return report
