"""Duplicate capsule IDs are ranked deterministically and remain non-mutating.

Git introduction, filesystem birth time, persisted first-seen time, then
canonical path select the primary. Every duplicate is warned and skipped
without changing either asset.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS as _OPTS,
)
from tests.unit.test_fs_store._md_harness import (
    md_indexer as _md_indexer,
)
from tests.unit.test_fs_store._md_harness import (
    md_sources as _sources,
)
from tests.unit.test_fs_store._md_harness import (
    seed_one_md as _seed_one,
)


def _capsule_id(path: Path) -> str | None:
    """The id the markdown carries — its frontmatter ``id:`` now."""
    from tests.fixtures.identity import frontmatter_id

    return frontmatter_id(path)


@pytest.mark.asyncio
async def test_move_keeps_id(tmp_path: Path) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    a.rename(b)  # old path gone → a MOVE
    await idx.index(IndexerOptions(**_OPTS))
    src = await _sources()
    assert list(src) == [aid], "a move keeps the same entity id"
    assert (src[aid][0] or "").endswith("b.md"), "asset_ref re-anchored to the new path"


@pytest.mark.asyncio
async def test_copy_is_warned_and_skipped_without_rekey(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    shutil.copyfile(a, b)  # both present, both carry the same comment capsule
    assert _capsule_id(b) == aid
    before = b.read_bytes()
    with caplog.at_level(logging.WARNING):
        result = await idx.index(IndexerOptions(**_OPTS))
    src = await _sources()
    assert list(src) == [aid]
    assert (src[aid][0] or "").endswith("a.md"), "the ranked primary stays stable"
    assert _capsule_id(b) == aid and b.read_bytes() == before
    assert result.per_type[RecordType.MARKDOWN].skipped == 2  # incumbent fresh + duplicate
    assert result.per_type[RecordType.MARKDOWN].duplicate_groups == 1
    assert result.per_type[RecordType.MARKDOWN].duplicate_occurrences == 1
    assert result.total_duplicate_groups == 1
    assert result.total_duplicate_occurrences == 1
    occurrence_paths = [item["path"] for item in src[aid][3]]
    assert occurrence_paths == [str(a.resolve()), str(b.resolve())]
    assert "duplicate asset id" in caplog.text
    assert f"id={aid}" in caplog.text


@pytest.mark.asyncio
async def test_copy_skip_is_idempotent(tmp_path: Path) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    shutil.copyfile(a, b)
    await idx.index(IndexerOptions(**_OPTS))
    ids_after_first = set(await _sources())
    b_bytes = b.read_bytes()
    await idx.index(IndexerOptions(**_OPTS, force=True))
    assert set(await _sources()) == ids_after_first == {aid}
    assert b.read_bytes() == b_bytes, "the duplicate capsule is never rewritten"


@pytest.mark.asyncio
async def test_missing_primary_promotes_remaining_occurrence(tmp_path: Path) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    shutil.copyfile(a, b)
    await idx.index(IndexerOptions(**_OPTS))

    a.unlink()
    result = await idx.index(IndexerOptions(**_OPTS))

    src = await _sources()
    assert (src[aid][0] or "").endswith("b.md")
    assert [item["path"] for item in src[aid][3]] == [str(b.resolve())]
    assert result.per_type[RecordType.MARKDOWN].indexed == 1


@pytest.mark.asyncio
async def test_legacy_singleton_row_persists_initial_occurrence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    driver = get_db_driver()
    entity = await driver.get_by_id(aid, "markdown")
    await entity.reflect_asset_occurrences(())
    original_sources = driver.list_entity_sources_by_type

    async def legacy_sources(type_name: str):
        rows = await original_sources(type_name)
        return {entity_id: source[:3] for entity_id, source in rows.items()}

    monkeypatch.setattr(driver, "list_entity_sources_by_type", legacy_sources)
    await idx.index(IndexerOptions(**_OPTS))

    rows = await original_sources("markdown")
    assert [item["path"] for item in rows[aid][3]] == [str(a.resolve())]


@pytest.mark.asyncio
async def test_legacy_dedup_flag_does_not_change_skip_policy(tmp_path: Path) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    shutil.copyfile(a, b)
    await idx.index(IndexerOptions(**_OPTS, dedup_on_adopt=False))
    assert _capsule_id(a) == _capsule_id(b) == aid
    assert set(await _sources()) == {aid}


@pytest.mark.asyncio
async def test_no_incumbent_uses_canonical_path_winner(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "flow_sdk.fs_store.asset_occurrences._trusted_birth_time",
        lambda _path: None,
    )
    await get_db_driver().delete_entities_by_type("markdown")
    docs = tmp_path / "proj" / "docs"
    docs.mkdir(parents=True)
    aid = "8858ca29-5b9a-4d1e-a74f-2b988586f71c"
    b = docs / "b.md"
    a = docs / "a.md"
    body = f"---\nid: {aid}\n---\n# duplicate\n"
    b.write_text(body, encoding="utf-8")
    a.write_text(body, encoding="utf-8")

    idx = _md_indexer(tmp_path / "proj")
    with caplog.at_level(logging.WARNING):
        await idx.index(IndexerOptions(**_OPTS))

    src = await _sources()
    assert set(src) == {aid}
    assert (src[aid][0] or "").endswith("a.md")
    assert f"kept={a.resolve()}" in caplog.text
    assert f"skipped={b.resolve()}" in caplog.text


@pytest.mark.asyncio
async def test_persisted_primary_beats_canonical_path_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "flow_sdk.fs_store.asset_occurrences._trusted_birth_time",
        lambda _path: None,
    )
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    a.rename(b)
    await idx.index(IndexerOptions(**_OPTS))
    shutil.copyfile(b, a)  # a sorts first, but b is the live DB source

    await idx.index(IndexerOptions(**_OPTS))

    src = await _sources()
    assert set(src) == {aid}
    assert (src[aid][0] or "").endswith("b.md")
    assert _capsule_id(a) == _capsule_id(b) == aid
