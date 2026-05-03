"""Phase 7b skip-fresh tests.

Covers the `asset_hash` / `is_valid` API on Record and the DB-preload
skip-fresh path in `FSIndexer.index()`.
"""

from __future__ import annotations

import asyncio
import os
import time as _time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_records.markdown_record import MarkdownRecord


@pytest.mark.asyncio
async def test_asset_hash_reads_source_mtime(tmp_path: Path) -> None:
    md = tmp_path / "x.md"
    md.write_text("# hi\n", encoding="utf-8")
    rec = MarkdownRecord.from_file(md)
    ah = rec.asset_hash
    assert ah > 0
    assert abs(ah - md.stat().st_mtime) < 0.1


def test_asset_hash_for_ref_file(tmp_path: Path) -> None:
    md = tmp_path / "x.md"
    md.write_text("# hi\n")
    ref = FSRef(md, read_only=True)
    ts = MarkdownRecord.asset_hash_for_ref(ref)
    assert ts == md.stat().st_mtime


@pytest.mark.asyncio
async def test_is_valid_requires_updated_date_newer_than_asset(tmp_path: Path) -> None:
    md = tmp_path / "y.md"
    md.write_text("body", encoding="utf-8")

    rec = MarkdownRecord.from_file(md)
    # No updated_date → not valid
    assert rec.is_valid() is False

    # updated_date in the past → asset is newer → not valid
    past = datetime.fromtimestamp(md.stat().st_mtime - 10, tz=timezone.utc)
    object.__getattribute__(rec, "__dict__")["updated_date"] = past
    assert rec.is_valid() is False

    # updated_date in the future → valid
    future = datetime.fromtimestamp(md.stat().st_mtime + 10, tz=timezone.utc)
    object.__getattribute__(rec, "__dict__")["updated_date"] = future
    assert rec.is_valid() is True


@pytest.mark.asyncio
async def test_indexer_skips_fresh_on_second_run(tmp_path: Path) -> None:
    """First run indexes, second run should report every ref as skipped."""
    # markdown_flat_fn looks under <root>/.claude/docs/**/*.md
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# a\n", encoding="utf-8")
    (docs / "b.md").write_text("# b\n", encoding="utf-8")

    driver = get_db_driver()

    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)

    # Clean any prior MARKDOWN rows for these two paths.
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    # First run: everything new.
    r1 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    per1 = r1.per_type.get(RecordType.MARKDOWN)
    assert per1 is not None, f"no MARKDOWN in result: {r1.per_type.keys()}"
    assert per1.indexed == 2
    assert per1.skipped == 0

    # Second run: DB rows exist with updated_date >= asset mtime → all skipped.
    r2 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    per2 = r2.per_type[RecordType.MARKDOWN]
    assert per2.indexed == 0
    assert per2.skipped == 2

    # Mutate one file → it should re-index while the other stays skipped.
    # mtime has 1s resolution on some filesystems — push 2s to be safe.
    new_ts = _time.time() + 2
    (docs / "a.md").write_text("# a updated\n", encoding="utf-8")
    os.utime(docs / "a.md", (new_ts, new_ts))

    r3 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    per3 = r3.per_type[RecordType.MARKDOWN]
    assert per3.indexed == 1
    assert per3.skipped == 1
