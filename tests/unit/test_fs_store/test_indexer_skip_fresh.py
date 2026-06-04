"""Skip-fresh tests for the on-disk ``.hash`` index-state model.

Covers the ``FSRecord`` index-state block (``record_hash`` / ``indexed_hash`` /
``indexed_at`` / ``index_required`` / ``orphan`` / ``write_hash``) and the
indexer's ``.hash``-based skip-fresh path in ``FSIndexer.index()``. Freshness
reuses the existing ``FSRef.fingerprint`` (mtime+size), digested into the
sentinel filename — there is no parallel hash primitive.
"""

from __future__ import annotations

import os
import time as _time
from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_types import RecordType


# ── FSRecord index-state block ───────────────────────────────────────────

def test_record_hash_nonempty_and_changes_with_source(tmp_path: Path) -> None:
    md = tmp_path / "doc.md"
    md.write_text("body", encoding="utf-8")
    rec = FSRecord(type="markdown", id="t-doc-1", asset_ref=FSRef(md))
    h1 = rec.record_hash
    assert h1  # non-empty digest
    new_ts = _time.time() + 5
    os.utime(md, (new_ts, new_ts))
    assert FSRecord(type="markdown", id="t-doc-1", asset_ref=FSRef(md)).record_hash != h1


def test_index_required_and_write_hash(tmp_path: Path) -> None:
    md = tmp_path / "doc.md"
    md.write_text("body", encoding="utf-8")
    rec = FSRecord(type="markdown", id="t-doc-2", asset_ref=FSRef(md))

    # Never indexed → no sentinel → required, no timestamp.
    assert rec.indexed_hash is None
    assert rec.indexed_at is None
    assert rec.index_required is True

    rec.write_hash()
    assert rec.indexed_hash == rec.record_hash
    assert rec.indexed_at is not None
    assert rec.index_required is False

    # Source changes → required again.
    new_ts = _time.time() + 5
    os.utime(md, (new_ts, new_ts))
    assert FSRecord(type="markdown", id="t-doc-2", asset_ref=FSRef(md)).index_required is True

    rec.clear_hash()
    assert FSRecord(type="markdown", id="t-doc-2", asset_ref=FSRef(md)).indexed_hash is None


def test_record_orphan_dynamic(tmp_path: Path) -> None:
    md = tmp_path / "doc.md"
    md.write_text("body", encoding="utf-8")
    rec = FSRecord(type="markdown", id="t-orphan-1", asset_ref=FSRef(md))
    assert rec.orphan is False
    md.unlink()
    assert rec.orphan is True


# ── Indexer integration ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_indexer_skips_fresh_on_second_run(tmp_path: Path) -> None:
    """First run indexes, second run skips by hash, a mutated file re-indexes."""
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# a\n", encoding="utf-8")
    (docs / "b.md").write_text("# b\n", encoding="utf-8")

    driver = get_db_driver()
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    r1 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    per1 = r1.per_type.get(RecordType.MARKDOWN)
    assert per1 is not None, f"no MARKDOWN in result: {r1.per_type.keys()}"
    assert per1.indexed == 2
    assert per1.skipped == 0

    # Second run: sentinels exist, sources unchanged → all skipped (no DB read).
    r2 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    per2 = r2.per_type[RecordType.MARKDOWN]
    assert per2.indexed == 0
    assert per2.skipped == 2

    # Mutate one file → it re-indexes; the other stays skipped.
    new_ts = _time.time() + 2
    (docs / "a.md").write_text("# a updated\n", encoding="utf-8")
    os.utime(docs / "a.md", (new_ts, new_ts))

    r3 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    per3 = r3.per_type[RecordType.MARKDOWN]
    assert per3.indexed == 1
    assert per3.skipped == 1


@pytest.mark.asyncio
async def test_force_reindexes_everything(tmp_path: Path) -> None:
    """`force` (Full mode) bypasses the sentinel and re-indexes unchanged files."""
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# a\n", encoding="utf-8")
    (docs / "b.md").write_text("# b\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)

    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    rf = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], force=True))
    perf = rf.per_type[RecordType.MARKDOWN]
    assert perf.indexed == 2
    assert perf.skipped == 0
