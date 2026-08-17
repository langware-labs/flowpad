"""Orphan accounting end-to-end.

Verifies the three things the scanner-page "perfect ground truth" relies on:

1. `get_index_status().per_type[*].orphan_count` and `total_orphans` reflect
   live DB state after the indexer marks a row's source as gone.
2. Re-indexing with `orphan_action=IGNORE` removes the orphan DB row but
   leaves the shadow record dir under `<records_root>/<type>/<id>/`
   intact.
3. Re-indexing with `orphan_action=DELETE` removes both DB row and shadow
   dir.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions, OrphanAction
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_paths import get_default_records_root
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry


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
    docs = root / "docs"
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
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    count_before, _, _ = await _markdown_status()

    # Source gone → run index → orphan detected (reported on the result),
    # row stays with the default INDEX action.
    md.unlink()
    result = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    count_after, _, _ = await _markdown_status()
    assert count_after == count_before, "row should still exist with default INDEX orphan action"
    assert result.per_type[RecordType.MARKDOWN].orphans_found >= 1


@pytest.mark.asyncio
async def test_orphan_clears_when_source_returns(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    # The first index stamped a v4 id into a.md's frontmatter capsule. Capture it
    # — under capsule-v4 an entity's identity is its capsule id, not its path, so
    # "the source returns" means the SAME capsule id returns.
    stamped = md.read_text(encoding="utf-8")

    md.unlink()
    result = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    assert result.per_type[RecordType.MARKDOWN].orphans_found >= 1

    # Restore the SAME entity (its capsule id) — it's seen again, so no orphan.
    md.write_text(stamped, encoding="utf-8")
    result2 = await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], force=True))
    assert result2.per_type[RecordType.MARKDOWN].orphans_found == 0


@pytest.mark.asyncio
async def test_orphan_action_ignore_removes_db_row_keeps_shadow_dir(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    # Capture the shadow dir for this record so we can assert it survives.
    records_root = get_default_records_root() / "markdown"
    shadow_dirs_before = sorted(p.name for p in records_root.iterdir()) if records_root.is_dir() else []
    assert shadow_dirs_before, "expected at least one markdown shadow dir on disk"

    md.unlink()
    result = await idx.index(
        IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], orphan_action=OrphanAction.IGNORE)
    )

    pt = result.per_type[RecordType.MARKDOWN]
    assert pt.orphans_found >= 1
    assert pt.orphans_db_removed >= 1
    assert pt.orphans_disk_removed == 0

    _, orphans_after, _ = await _markdown_status()
    assert orphans_after == 0, "ignore action should drop the orphan DB row"

    # Shadow dir for the cleared record must still be on disk.
    shadow_dirs_after = sorted(p.name for p in records_root.iterdir()) if records_root.is_dir() else []
    assert set(shadow_dirs_before).issubset(set(shadow_dirs_after))


@pytest.mark.asyncio
async def test_db_only_orphan_without_shadow_dir_is_swept(tmp_path: Path) -> None:
    """A DB row whose shadow dir is gone (e.g. deleted out-of-band) must still
    be sweepable when its declared source (asset_ref) no longer exists.

    Regression: orphan candidates used to come ONLY from the record homes on
    disk, so DB-only rows were invisible to the sweep forever."""
    import shutil

    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))
    count_before, _, _ = await _markdown_status()
    assert count_before >= 1

    # Remove BOTH the source and the shadow dir — only the DB row remains.
    md.unlink()
    records_root = get_default_records_root() / "markdown"
    shutil.rmtree(records_root, ignore_errors=True)

    result = await idx.index(
        IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], orphan_action=OrphanAction.IGNORE)
    )

    pt = result.per_type[RecordType.MARKDOWN]
    assert pt.orphans_found >= 1, "DB-only row with missing asset_ref must be detected"
    assert pt.orphans_db_removed >= 1
    count_after, _, _ = await _markdown_status()
    assert count_after == count_before - 1, "the DB-only orphan row should be gone"


@pytest.mark.asyncio
async def test_db_only_row_with_live_source_is_not_swept(tmp_path: Path) -> None:
    """Safety: a DB row not derivable from the walk (no shadow dir, id differs
    from the path-derived one) but whose asset_ref still EXISTS is alive — the
    sweep must not touch it. Guards the API-minted-v4-beside-path-minted-v5
    twin-row case."""
    import shutil
    import uuid

    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.fs_ref import FSRef as _FSRef

    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    # Twin row: different (random v4) id, same still-existing source file.
    twin_id = str(uuid.uuid4())
    twin = FSRecord(type=str(RecordType.MARKDOWN), id=twin_id, name="twin")
    object.__setattr__(twin, "asset_ref", _FSRef(md))
    await twin.sync_to_db()
    # Drop the twin's shadow dir so it is a DB-only row.
    shutil.rmtree(
        get_default_records_root() / "markdown" / str(twin_id),
        ignore_errors=True,
    )

    result = await idx.index(
        IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], orphan_action=OrphanAction.DELETE)
    )

    pt = result.per_type.get(RecordType.MARKDOWN)
    orphan_ids = tuple(pt.orphan_ids) if pt is not None else ()
    assert twin_id not in orphan_ids, "row with a live source must not be classified orphan"
    row = await driver.get_by_id(twin_id, str(RecordType.MARKDOWN))
    assert row is not None, "live-source DB-only row must survive a DELETE sweep"


@pytest.mark.asyncio
async def test_orphan_action_delete_removes_db_row_and_shadow_dir(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    records_root = get_default_records_root() / "markdown"
    shadow_dirs_before = {p.name for p in records_root.iterdir()} if records_root.is_dir() else set()
    assert shadow_dirs_before, "expected shadow dir to exist after index"

    md.unlink()
    result = await idx.index(
        IndexerOptions(verbose=False, types=[RecordType.MARKDOWN], orphan_action=OrphanAction.DELETE)
    )

    pt = result.per_type[RecordType.MARKDOWN]
    assert pt.orphans_found >= 1
    assert pt.orphans_db_removed >= 1
    assert pt.orphans_disk_removed >= 1

    shadow_dirs_after = {p.name for p in records_root.iterdir()} if records_root.is_dir() else set()
    # At least one shadow dir we observed before must be gone now.
    assert shadow_dirs_before - shadow_dirs_after, (
        f"DELETE should remove the orphan shadow dir; before={shadow_dirs_before} after={shadow_dirs_after}"
    )


@pytest.mark.asyncio
async def test_scoped_index_survives_a_db_only_orphan(tmp_path: Path) -> None:
    """A scoped index run must not blow up on a DB-only orphan.

    The scope filter narrows orphan candidates; for a DB-only row (no shadow
    dir to read provenance from) it reads that provenance off the row the
    driver returns. ``list_entity_sources_by_type`` returns FIVE columns
    (asset_ref, scope, project_id, asset_occurrences, created_date) since
    duplicate-occurrence detection landed, but the predicate unpacked exactly
    three — so the whole run died with ``too many values to unpack``, not just
    the orphan check. Every edit the pass would have persisted (an agent's
    task status / process_id / analysis paths) was silently lost with it.
    """
    import shutil

    from flow_sdk.server.search_filters import ScopeFilter

    root = tmp_path / "proj"
    docs = root / "docs"
    docs.mkdir(parents=True)
    md = docs / "a.md"
    md.write_text("# a\n", encoding="utf-8")

    driver = get_db_driver()
    await driver.delete_entities_by_type(str(RecordType.MARKDOWN))

    idx = _build_indexer(root)
    await idx.index(IndexerOptions(verbose=False, types=[RecordType.MARKDOWN]))

    # Strand the row: source and shadow dir both gone (a deleted task folder),
    # leaving a real DB-only orphan for the scoped pass to classify.
    md.unlink()
    shutil.rmtree(get_default_records_root() / "markdown", ignore_errors=True)

    # A live doc the pass must still persist — the collateral damage the crash
    # caused, since one bad row aborted the ENTIRE run.
    (docs / "b.md").write_text("# b\n", encoding="utf-8")

    result = await idx.index(
        IndexerOptions(
            verbose=False,
            types=[RecordType.MARKDOWN],
            scope_filter=ScopeFilter(user=True),
            orphan_action=OrphanAction.IGNORE,
        )
    )

    assert result.per_type[RecordType.MARKDOWN].orphans_found >= 1
    rows = await driver.list_entity_sources_by_type(str(RecordType.MARKDOWN))
    assert any(str(r[0] or "").endswith("b.md") for r in rows.values()), (
        "the scoped run must still index live files alongside the orphan"
    )
