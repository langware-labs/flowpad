"""Rename a persisted entity TYPE string everywhere it is stored — a primitive a rename migration calls.

A type string is the ``type`` half of every ``TypeId`` and is persisted, so renaming one touches, the
database first because that half is one transaction:

1. ``entities.type``; ``type_uname`` (``<type>:<uname>``), yielding its claim when the new type already
   holds that uname; the blob's own ``$.type``; ``record_data_ref`` (``<type>/<id>``).
2. The type columns of ``relationships``, ``links`` and ``entities_fts`` (skipping FTS silently breaks
   type-filtered search).
3. TypeIds inside other rows' blobs (a tab target, a graph context): only a JSON string that IS a TypeId
   — ``<old>-<uuid>`` / ``<old>:<uuid>`` — is rewritten. A blanket replace would corrupt every field
   that merely starts with the type name (``data_source_id``) and every neighbouring type.
4. The metadata-only shadow folders under the records roots: a row-only entity has no disk carrier to
   regenerate from, so its shadow IS its data and must MOVE. A destination that already exists is a
   conflict, left in place and reported — never merged or overwritten.

Every match is exact equality or an exact prefix, never ``LIKE``. A dry run executes the same statements
and rolls back, so the counts are the ones an apply would produce. The database is backed up to
``<db>.pre-<new>.bak`` before the first applied write. Idempotent: a second run matches nothing, and a run
interrupted between the commit and the folder moves finishes the moves on the next.
"""

from __future__ import annotations

import json
import re
import shutil
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flow_sdk.api.api_types.identifier import UUID_PATTERN

#: The type columns outside ``entities`` — each is rewritten where it names the old type.
TYPE_COLUMNS = {
    "relationships": ("from_type", "to_type"),
    "links": ("src_type", "target_resolved_type"),
    "entities_fts": ("type",),
}


@dataclass
class Report:
    old: str
    new: str
    #: True when nothing was written — the counts are then what an apply would change
    dry_run: bool = True
    #: ``"<table>.<column>"`` -> rows rewritten (``entities.typeids`` counts TypeId strings)
    counts: Counter = field(default_factory=Counter)
    shadows_moved: int = 0
    shadow_conflicts: list[str] = field(default_factory=list)

    @property
    def rows(self) -> int:
        return self.counts["entities.type"]

    @property
    def changed(self) -> bool:
        return bool(sum(self.counts.values()) or self.shadows_moved) and not self.dry_run

    def summary(self) -> str:
        verb = "would rename" if self.dry_run else "renamed"
        return (f"type {self.old} -> {self.new}: {verb} {self.rows} row(s), "
                f"{self.counts['relationships'] + self.counts['links']} edge/link row(s), "
                f"{self.counts['entities.typeids']} typeid(s); moved {self.shadows_moved} shadow(s), "
                f"{len(self.shadow_conflicts)} conflict(s).")


def _columns(conn: Any, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}  # a missing table has none


def _retyper(old: str, new: str):
    """``walk(value) -> (value, rewritten)`` rewriting every JSON string that is an ``old`` TypeId."""
    typeid = re.compile(rf"^{re.escape(old)}([-:])({UUID_PATTERN})$")

    def walk(value: Any, hits: list[int]) -> Any:
        if isinstance(value, str):
            match = typeid.match(value)
            if match:
                hits[0] += 1
                return f"{new}{match.group(1)}{match.group(2)}"
            return value
        if isinstance(value, list):
            return [walk(item, hits) for item in value]
        if isinstance(value, dict):
            return {key: walk(item, hits) for key, item in value.items()}
        return value

    def retype(value: Any) -> tuple[Any, int]:
        hits = [0]
        return walk(value, hits), hits[0]

    return retype


def _migrate_database(conn: Any, old: str, new: str, counts: Counter) -> None:
    run = lambda sql, *args: conn.execute(sql, args).rowcount  # noqa: E731 — one rowcount per statement
    entity_columns = _columns(conn, "entities")
    if "type_uname" in entity_columns:
        # A uname the new type already holds keeps its owner; the incoming row gives up only its claim.
        counts["entities.uname_collisions"] = run(
            "UPDATE entities SET type_uname = NULL WHERE type = ? AND uname IS NOT NULL AND EXISTS "
            "(SELECT 1 FROM entities held WHERE held.type_uname = ? || ':' || entities.uname)", old, new)
    counts["entities.type"] = run("UPDATE entities SET type = ? WHERE type = ?", new, old)
    if "type_uname" in entity_columns:
        counts["entities.type_uname"] = run(
            "UPDATE entities SET type_uname = ? || substr(type_uname, ?) WHERE type = ? AND type_uname >= ? AND type_uname < ?",
            f"{new}:", len(old) + 2, new, f"{old}:", f"{old};")
    counts["entities.$type"] = run(
        "UPDATE entities SET data = json_set(data, '$.type', ?) WHERE type = ? AND json_valid(data) "
        "AND json_extract(data, '$.type') = ?", new, new, old)
    if "record_data_ref" in entity_columns:
        # A range, not substr(): the column is indexed.
        counts["entities.record_data_ref"] = run(
            "UPDATE entities SET record_data_ref = ? || substr(record_data_ref, ?) WHERE record_data_ref >= ? AND record_data_ref < ?",
            f"{new}/", len(old) + 2, f"{old}/", f"{old}0")
    for table, columns in TYPE_COLUMNS.items():
        present = [c for c in columns if c in _columns(conn, table)]
        if present:
            sets = ", ".join(f"{c} = CASE WHEN {c} = ? THEN ? ELSE {c} END" for c in present)
            where = " OR ".join(f"{c} = ?" for c in present)
            args = [x for _ in present for x in (old, new)] + [old] * len(present)
            counts[table] = run(f"UPDATE {table} SET {sets} WHERE {where}", *args)
    # TypeIds inside blobs: the quote anchors a JSON string VALUE that starts with the TypeId.
    retype = _retyper(old, new)
    rewrites = []
    for row_id, data in conn.execute(
        "SELECT id, data FROM entities WHERE instr(data, ?) > 0 OR instr(data, ?) > 0", (f'"{old}-', f'"{old}:')
    ):
        try:
            blob, hits = retype(json.loads(data))
        except (TypeError, ValueError):
            continue
        if hits:
            counts["entities.typeids"] += hits
            rewrites.append((json.dumps(blob), row_id))
    conn.executemany("UPDATE entities SET data = ? WHERE id = ?", rewrites)


def _move_shadows(roots: list[Path], old: str, new: str, report: Report) -> None:
    for root in roots:
        source, dest_root = root / old, root / new
        if not source.is_dir():
            continue
        for child in sorted(source.iterdir()):
            dest = dest_root / child.name
            if dest.exists():
                report.shadow_conflicts.append(str(child))
                continue
            report.shadows_moved += 1
            if report.dry_run:
                continue
            dest_root.mkdir(parents=True, exist_ok=True)
            child.rename(dest)
            meta = dest / "metadata.json"
            try:
                data = json.loads(meta.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and data.get("type") == old:  # else it would load under the old type
                data["type"] = new
                meta.write_text(json.dumps(data, indent=2), encoding="utf-8")
        if not report.dry_run:
            try:
                source.rmdir()  # only when every child moved
            except OSError:
                pass


def rename_entity_type(
    old: str, new: str, *, dry_run: bool = True, db: Path | None = None, shadow_roots: list[Path] | None = None
) -> Report:
    """Rename the type string ``old`` to ``new`` in the instance database and its shadow folders."""
    from flow_sdk.fs_store.record_paths import get_default_records_data_root, get_default_records_root
    from flow_sdk.migrations.migration_2026_09_identity_live_forms import _db_path, _open

    report = Report(old=old, new=new, dry_run=dry_run)
    db = Path(db) if db is not None else _db_path()
    if db.is_file():
        backup = db.with_name(f"{db.name}.pre-{new}.bak")
        if not dry_run and not backup.exists():
            shutil.copy2(db, backup)
        conn = _open(db)
        try:
            if _columns(conn, "entities"):
                _migrate_database(conn, old, new, report.counts)
            (conn.rollback if dry_run else conn.commit)()
        finally:
            conn.close()
    roots = shadow_roots if shadow_roots is not None else [get_default_records_root(), get_default_records_data_root()]
    _move_shadows(roots, old, new, report)
    return report
