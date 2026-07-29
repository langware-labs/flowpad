"""Regression guard for the typeless-record persistence bug.

`Entity.from_record` resolves `entity_cls = SchemaRegistry.get_entity_cls(type) or Entity`.
Most record types (markdown, workflow, claude_hook, ...) have no registered
subclass — entity_cls falls back to base Entity, whose `get_type()` returns
"entity". Prior to the fix, the existence check used
`entity_cls.get_one(QueryFilter.parse({"id": X}))` which the QueryFilter
parser stamped with `type="entity"`. Since the actual row has
`type="markdown"`, the lookup missed it, took the create-new branch, and
the resulting UPDATE on a freshly-constructed Entity left `updated_date`
unchanged (apply_update_fields only stamps when None, and the entity's
in-memory `updated_date` was either inherited from the parsed file or
silently held from the constructed entity).

These tests assert that for a typeless record, a re-index after the file's
mtime advances actually moves the DB's `updated_date` forward.
"""

from __future__ import annotations

import os
import time as _time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import text

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_types import RecordType


async def _max_updated_date(driver, type_name: str) -> datetime | None:
    async with driver._session_ctx() as session:
        row = (await session.execute(
            text("SELECT MAX(updated_date) FROM entities WHERE type = :t"),
            {"t": type_name},
        )).fetchone()
    if not row or row[0] is None:
        return None
    val = row[0]
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    # SQLite returns strings — parse "YYYY-MM-DD HH:MM:SS[.f]"
    return datetime.fromisoformat(str(val).replace(" ", "T")).replace(tzinfo=timezone.utc)


@pytest.mark.asyncio
async def test_typeless_record_update_advances_updated_date(tmp_path: Path) -> None:
    """A markdown row (typeless — no Entity subclass registered) must have
    its DB `updated_date` advance when the source file's mtime moves past
    the stored value. Before the from_record fix this silently regressed.
    """
    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "x.md"
    md.write_text("# initial\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)

    r1 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    assert r1.per_type[RecordType.MARKDOWN].indexed == 1
    ud1 = await _max_updated_date(driver, str(RecordType.MARKDOWN))
    assert ud1 is not None

    # Bump the file's mtime (and content) past the DB's recorded updated_date
    # so skip-fresh decides to re-index.
    new_ts = _time.time() + 2
    md.write_text("# updated\n", encoding="utf-8")
    os.utime(md, (new_ts, new_ts))

    r2 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    assert r2.per_type[RecordType.MARKDOWN].indexed == 1, "expected re-index after mtime bump"

    ud2 = await _max_updated_date(driver, str(RecordType.MARKDOWN))
    assert ud2 is not None
    assert ud2 > ud1, f"updated_date must advance on re-sync; ud1={ud1}, ud2={ud2}"


@pytest.mark.asyncio
async def test_typeless_record_single_row_no_duplicate_on_resync(tmp_path: Path) -> None:
    """Sanity guard: re-syncing the same file must NOT create a duplicate row.
    Before the fix the get_one miss → create-branch could collide on id and
    rely on driver.save's id-existence guard; this asserts the row count
    stays at 1 across multiple re-indexes.
    """
    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    (docs / "only.md").write_text("# one\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)

    for i in range(3):
        new_ts = _time.time() + (i + 1) * 2
        os.utime(docs / "only.md", (new_ts, new_ts))
        await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    async with driver._session_ctx() as session:
        row = (await session.execute(
            text("SELECT COUNT(*) FROM entities WHERE type = 'markdown'")
        )).fetchone()
    assert row[0] == 1, f"expected exactly 1 markdown row after 3 re-syncs, got {row[0]}"
