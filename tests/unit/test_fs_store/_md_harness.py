"""Shared markdown-indexing harness for capsule-id tests.

One tiny FSIndexer over a temp tree with ``markdown_flat_fn`` — the smallest
setup that exercises the full probe → gen-id → sync → sweep path. Used by
``test_indexer_dedup_on_adopt`` and ``test_indexer_same_path_dupes`` (and
``_fm_id`` by ``test_system_project_asset_ids``).
"""
from __future__ import annotations

from pathlib import Path

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_types import RecordType

MD_OPTS = dict(verbose=False, types=[RecordType.MARKDOWN])


def md_indexer(root: Path) -> FSIndexer:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    return idx


async def md_sources() -> dict:
    return await get_db_driver().list_entity_sources_by_type("markdown")


def fm_id(p: Path):
    fm = _extract_frontmatter(p.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


async def seed_one_md(tmp_path: Path) -> tuple[FSIndexer, Path, str]:
    """Index a single ``a.md`` and return (indexer, path, its stamped id)."""
    docs = tmp_path / "proj" / "docs"
    docs.mkdir(parents=True)
    await get_db_driver().delete_entities_by_type("markdown")
    a = docs / "a.md"
    a.write_text("# a\nbody\n", encoding="utf-8")
    idx = md_indexer(tmp_path / "proj")
    await idx.index(IndexerOptions(**MD_OPTS))
    src = await md_sources()
    assert len(src) == 1
    return idx, a, next(iter(src))
