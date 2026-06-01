"""Orphan accounting end-to-end.

Verifies the three things the scanner-page "perfect ground truth" relies on:

1. `get_index_status().per_type[*].orphan_count` and `total_orphans` reflect
   live DB state after the indexer marks a row's source as gone.
2. Re-indexing with `orphan_action=IGNORE` removes the orphan DB row but
   leaves the shadow record dir under `<records_root>/<type>/<type>-@<id>/`
   intact.
3. Re-indexing with `orphan_action=DELETE` removes both DB row and shadow
   dir.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions, OrphanAction
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_paths import get_default_records_root
from flow_sdk.fs_store.record_types import RecordType


def _build_indexer(root: Path) -> FSIndexer:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    return idx


async def _markdown_status() -> tuple[int, int, int]:
    """(entity_count, orphan_count, total_orphans) for the markdown type."""
    status = await SchemaRegistry.get_index_status(types=["markdown"])
    pt = next((t for t in status.per_type if t.type_name == "markdown"), None)
    assert pt is not None, "markdown row missing from index status"
    return pt.entity_count, pt.orphan_count, status.total_orphans


@pytest.mark.asyncio
async def test_orphan_count_zero_on_fresh_index(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    (docs / "a.md").write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    count, orphans, total = await _markdown_status()
    assert count >= 1
    assert orphans == 0
    assert total == 0


@pytest.mark.asyncio
async def test_orphan_appears_after_source_delete(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    count_before, orphans_before, _ = await _markdown_status()
    assert orphans_before == 0

    # Source gone → run index → orphan flag is set, row stays.
    md.unlink()
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    count_after, orphans_after, total_after = await _markdown_status()
    assert count_after == count_before, "row should still exist with default INDEX orphan action"
    assert orphans_after >= 1
    assert total_after == orphans_after


@pytest.mark.asyncio
async def test_orphan_clears_when_source_returns(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    md.unlink()
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    _, orphans_after_delete, _ = await _markdown_status()
    assert orphans_after_delete >= 1

    # Restore the source — orphan flag must be cleared on next walk.
    md.write_text("# a back\n", encoding="utf-8")
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], force=True))
    _, orphans_after_restore, _ = await _markdown_status()
    assert orphans_after_restore == 0


@pytest.mark.asyncio
async def test_orphan_action_ignore_removes_db_row_keeps_shadow_dir(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    # Capture the shadow dir for this record so we can assert it survives.
    records_root = get_default_records_root() / "markdown"
    shadow_dirs_before = (
        sorted(p.name for p in records_root.iterdir()) if records_root.is_dir() else []
    )
    assert shadow_dirs_before, "expected at least one markdown shadow dir on disk"

    md.unlink()
    result = await idx.index(
        IndexerOptions(
            verbose=False, types=[RecordType.MARKDOWN], orphan_action=OrphanAction.IGNORE
        )
    )

    pt = result.per_type[RecordType.MARKDOWN]
    assert pt.orphans_found >= 1
    assert pt.orphans_db_removed >= 1
    assert pt.orphans_disk_removed == 0

    _, orphans_after, _ = await _markdown_status()
    assert orphans_after == 0, "ignore action should drop the orphan DB row"

    # Shadow dir for the cleared record must still be on disk.
    shadow_dirs_after = (
        sorted(p.name for p in records_root.iterdir()) if records_root.is_dir() else []
    )
    assert set(shadow_dirs_before).issubset(set(shadow_dirs_after))


@pytest.mark.asyncio
async def test_orphan_action_delete_removes_db_row_and_shadow_dir(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / ".claude" / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    records_root = get_default_records_root() / "markdown"
    shadow_dirs_before = (
        {p.name for p in records_root.iterdir()} if records_root.is_dir() else set()
    )
    assert shadow_dirs_before, "expected shadow dir to exist after index"

    md.unlink()
    result = await idx.index(
        IndexerOptions(
            verbose=False, types=[RecordType.MARKDOWN], orphan_action=OrphanAction.DELETE
        )
    )

    pt = result.per_type[RecordType.MARKDOWN]
    assert pt.orphans_found >= 1
    assert pt.orphans_db_removed >= 1
    assert pt.orphans_disk_removed >= 1

    shadow_dirs_after = (
        {p.name for p in records_root.iterdir()} if records_root.is_dir() else set()
    )
    # At least one shadow dir we observed before must be gone now.
    assert shadow_dirs_before - shadow_dirs_after, (
        f"DELETE should remove the orphan shadow dir; before={shadow_dirs_before} after={shadow_dirs_after}"
    )
