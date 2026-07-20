"""Fast contracts for passing one resolved asset ID through every parser path."""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

import pytest

from flow_sdk.builtin.claude_memory_entities import Markdown
from flow_sdk.builtin.faas.fs_records_actions import discover_record_by_path
from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS,
    fm_id,
    md_indexer,
    md_sources,
    seed_one_md,
)

CANONICAL_ID = "1743cb5d-f670-4e26-b6f6-c62b65522f7c"
LEGACY_ID = "a80e0616-ef1a-4dd7-a986-c7ce1ae18bdb"


def _conflicting_markdown(tmp_path: Path) -> Path:
    path = tmp_path / "proj" / ".claude" / "docs" / "conflict.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        f"---\nid: {CANONICAL_ID}\nasset_id: {LEGACY_ID}\n---\n# conflict\n",
        encoding="utf-8",
    )
    return path


@pytest.mark.asyncio
async def test_full_index_passes_resolved_id_to_parser(tmp_path: Path) -> None:
    await get_db_driver().delete_entities_by_type("markdown")
    path = _conflicting_markdown(tmp_path)

    await md_indexer(tmp_path / "proj").index(IndexerOptions(**MD_OPTS))

    assert set(await md_sources()) == {CANONICAL_ID}
    assert fm_id(path) == CANONICAL_ID


@pytest.mark.asyncio
async def test_targeted_discover_mints_then_passes_same_id(tmp_path: Path) -> None:
    await get_db_driver().delete_entities_by_type("markdown")
    path = tmp_path / "new.md"
    path.write_text("# new\n", encoding="utf-8")

    record = await discover_record_by_path("markdown", str(path))

    assert record is not None
    assert record.id == fm_id(path)
    assert set(await md_sources()) == {record.id}


def test_db_free_loader_passes_resolved_id_to_parser(tmp_path: Path) -> None:
    path = _conflicting_markdown(tmp_path)

    loaded = Markdown.from_fs_ref(FSRef(path, record_type=RecordType.MARKDOWN))

    assert loaded is not None
    assert loaded.id == CANONICAL_ID


@pytest.mark.asyncio
async def test_targeted_discover_warns_and_skips_live_duplicate(
    tmp_path: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    _idx, incumbent, asset_id = await seed_one_md(tmp_path)
    duplicate = incumbent.with_name("duplicate.md")
    shutil.copyfile(incumbent, duplicate)

    with caplog.at_level(logging.WARNING):
        record = await discover_record_by_path("markdown", str(duplicate))

    assert record is None
    assert fm_id(duplicate) == asset_id
    assert set(await md_sources()) == {asset_id}
    assert "duplicate asset id" in caplog.text
