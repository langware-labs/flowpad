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
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer.walkers.generic import walker_for
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
    docs = root / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# a\n", encoding="utf-8")
    (docs / "b.md").write_text("# b\n", encoding="utf-8")

    driver = get_db_driver()
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))
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
async def test_stale_sentinel_without_db_row_reindexes(tmp_path: Path) -> None:
    """A fresh on-disk sentinel must NOT mask a missing DB row.

    Regression for the "only 3 of 589 markdowns show" bug: a DB clear/rebuild
    drops rows but leaves the shadow store's ``.hash`` sentinels. Skip-fresh
    must require the entity row to exist — not just a matching sentinel — or it
    skips re-creating the row forever and the records stay invisible.
    """
    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# a\n", encoding="utf-8")
    (docs / "b.md").write_text("# b\n", encoding="utf-8")

    driver = get_db_driver()
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    # First run: rows + sentinels created.
    r1 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    assert r1.per_type[RecordType.MARKDOWN].indexed == 2
    rows = await driver.list_entity_sources_by_type(str(RecordType.MARKDOWN))
    assert len(rows) == 2

    # Simulate a DB clear/rebuild that leaves the shadow store intact:
    # delete_entities_by_type drops rows (+FTS) but does NOT touch the on-disk
    # .hash sentinels (only the DELETE /index handler / clear_hashes_for_type
    # does). So the sentinels are now stale — fresh-looking, but no row.
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))
    assert len(await driver.list_entity_sources_by_type(str(RecordType.MARKDOWN))) == 0
    # Sentinels still report the sources as fresh (sources unchanged).
    assert FSRecord(type="markdown", id="t-x", asset_ref=FSRef(docs / "a.md")).record_hash

    # Second run (NO force): sentinels match but rows are gone → must re-index,
    # not skip-fresh.
    r2 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    per2 = r2.per_type[RecordType.MARKDOWN]
    assert per2.indexed == 2, f"expected re-index of both, got indexed={per2.indexed} skipped={per2.skipped}"
    assert per2.skipped == 0
    assert len(await driver.list_entity_sources_by_type(str(RecordType.MARKDOWN))) == 2


@pytest.mark.asyncio
async def test_force_reindexes_everything(tmp_path: Path) -> None:
    """`force` (Full mode) bypasses the sentinel and re-indexes unchanged files."""
    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# a\n", encoding="utf-8")
    (docs / "b.md").write_text("# b\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, walker_for("markdown"))

    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    rf = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], force=True))
    perf = rf.per_type[RecordType.MARKDOWN]
    assert perf.indexed == 2
    assert perf.skipped == 0


# ── Path-aware re-anchor (location drift) ────────────────────────────────
#
# Freshness is mtime+size — deliberately path-blind. A relocation that
# preserves mtime+size (wheel install / ``cp -p`` / archive extract) leaves the
# content token unchanged, so location drift must be caught separately or a
# moved record keeps a stale ``asset_ref`` forever. These cover the 3-part
# sentinel (``<epoch>_<contenthash>_<pathdigest>``) and the legacy-sentinel
# reconcile that avoids a mass reindex of unmoved records.

def test_write_hash_records_path_digest(tmp_path: Path) -> None:
    from flow_sdk.fs_store.fs_record import _digest

    md = tmp_path / "doc.md"
    md.write_text("body", encoding="utf-8")
    rec = FSRecord(type="markdown", id="pd-1", asset_ref=FSRef(md))
    rec.write_hash()
    # 3-part sentinel: content hash still parses AND a path digest is recorded.
    assert rec.indexed_hash == rec.record_hash
    assert rec.indexed_path_digest == _digest(FSRef(md).path)
    assert rec.index_required is False


def test_index_required_on_relocation_with_identical_content(tmp_path: Path) -> None:
    file_a = tmp_path / "a" / "Welcome.md"
    file_b = tmp_path / "b" / "Welcome.md"
    file_a.parent.mkdir()
    file_b.parent.mkdir()
    file_a.write_text("welcome", encoding="utf-8")
    file_b.write_text("welcome", encoding="utf-8")
    # Identical mtime+size → identical content freshness token (mtime-preserving
    # copy). The only difference is the path.
    ts = 1_700_000_000
    os.utime(file_a, (ts, ts))
    os.utime(file_b, (ts, ts))

    rid = "reanchor-doc-1"
    rec_a = FSRecord(type="markdown", id=rid, asset_ref=FSRef(file_a))
    rec_a.write_hash()  # indexed at path A

    rec_b = FSRecord(type="markdown", id=rid, asset_ref=FSRef(file_b))
    # Content token is path-blind: identical for A and B.
    assert rec_b.record_hash == rec_a.record_hash
    # …but the path digest differs → re-anchor required.
    assert rec_b.index_required is True
    # The unmoved record stays fresh (no spurious reindex).
    assert FSRecord(type="markdown", id=rid, asset_ref=FSRef(file_a)).index_required is False


def test_legacy_sentinel_reconciles_only_moved_records(tmp_path: Path) -> None:
    file_a = tmp_path / "a" / "Welcome.md"
    file_b = tmp_path / "b" / "Welcome.md"
    file_a.parent.mkdir()
    file_b.parent.mkdir()
    file_a.write_text("hi", encoding="utf-8")
    file_b.write_text("hi", encoding="utf-8")
    ts = 1_700_000_000
    os.utime(file_a, (ts, ts))
    os.utime(file_b, (ts, ts))

    rid = "legacy-doc-1"
    rec_a = FSRecord(type="markdown", id=rid, asset_ref=FSRef(file_a))
    rec_a.save()  # persist metadata.json with asset_ref = path A (a prior index)
    # Hand-write a LEGACY 2-part sentinel (no path digest), as older builds did.
    folder = rec_a.shadow_dir
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{int(ts)}_{rec_a.record_hash}.hash").touch()

    assert rec_a.indexed_path_digest is None  # legacy shape
    # Unmoved (path A, content fresh) → reconcile finds persisted == current → fresh.
    assert FSRecord(type="markdown", id=rid, asset_ref=FSRef(file_a)).index_required is False
    # Moved to B (content token identical) → persisted A != B → re-anchor required.
    assert FSRecord(type="markdown", id=rid, asset_ref=FSRef(file_b)).index_required is True


@pytest.mark.asyncio
async def test_claude_md_skips_fresh_on_second_run(tmp_path: Path) -> None:
    """A CLAUDE.md unchanged since the last run must be skipped, like markdown.

    Regression: on a live backend `?type=claude_md` reported
    `indexed=6 new=6 skipped=0` on EVERY run, forever — the 6 files were
    re-parsed on every index. The instrumented probe showed the sentinel side
    was healthy (`index_required=False`) and freshness was denied by the DB-row
    gate instead (`row_present=False`), because `existing_db_ids["claude_md"]`
    is empty: `claude_md` never appears among the enumerable entity types.
    """
    from flow_sdk.fs_store.indexer.functions.claude_md import (
        claude_md_in_project_root_fn,
    )

    root = tmp_path / "proj"
    root.mkdir(parents=True)
    (root / "CLAUDE.md").write_text("# guidance\n", encoding="utf-8")

    driver = get_db_driver()
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER))
    idx.add_function(RecordType.USER_HOME_FOLDER, claude_md_in_project_root_fn)
    await driver.delete_entities_by_type(str(RecordType.CLAUDE_MD))

    r1 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.CLAUDE_MD]))
    per1 = r1.per_type.get(RecordType.CLAUDE_MD)
    assert per1 is not None, f"no CLAUDE_MD in result: {r1.per_type.keys()}"
    assert per1.indexed == 1
    assert per1.skipped == 0

    # Second run: file untouched → must skip, exactly as MARKDOWN does above.
    r2 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.CLAUDE_MD]))
    per2 = r2.per_type[RecordType.CLAUDE_MD]
    assert per2.skipped == 1, (
        f"unchanged CLAUDE.md was re-parsed: indexed={per2.indexed} skipped={per2.skipped}"
    )
    assert per2.indexed == 0
