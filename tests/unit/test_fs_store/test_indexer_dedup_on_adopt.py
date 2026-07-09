"""Phase 3 — dedup-on-adopt: a capsule id survives move+rename, but a local copy
(``cp -r``) is re-keyed so two files never collapse into one entity row.

Uses markdown (frontmatter capsule) through the full index path — the dedup lives
in ``FSIndexer._probe_chunk``. Mirrors the ``test_indexer_orphans`` harness.
"""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import pytest

from flow_sdk.db import get_db_driver
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import FSIndexer, IndexerOptions
from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.indexer.functions.markdown import markdown_flat_fn
from flow_sdk.fs_store.record_types import RecordType

_OPTS = dict(verbose=False, types=[RecordType.MARKDOWN])


def _indexer(root: Path) -> FSIndexer:
    idx = FSIndexer()
    idx.add_root(FSRef(root, record_type=RecordType.USER_HOME_FOLDER, scope="user"))
    idx.add_function(RecordType.USER_HOME_FOLDER, markdown_flat_fn)
    return idx


async def _sources() -> dict:
    return await get_db_driver().list_entity_sources_by_type("markdown")


def _fm_id(p: Path):
    fm = _extract_frontmatter(p.read_text(encoding="utf-8"))
    return (_yaml_load(fm) or {}).get("id") if fm else None


async def _seed_one(tmp_path: Path) -> tuple[FSIndexer, Path, str]:
    """Index a single ``a.md`` and return (indexer, path, its stamped id)."""
    docs = tmp_path / "proj" / ".claude" / "docs"
    docs.mkdir(parents=True)
    await get_db_driver().delete_entities_by_type("markdown")
    a = docs / "a.md"
    a.write_text("# a\nbody\n", encoding="utf-8")
    idx = _indexer(tmp_path / "proj")
    await idx.index(IndexerOptions(**_OPTS))
    src = await _sources()
    assert len(src) == 1
    return idx, a, next(iter(src))


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
async def test_copy_rekeys_into_a_distinct_entity(tmp_path: Path) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    shutil.copyfile(a, b)  # both present, both carry the same frontmatter id
    assert _fm_id(b) == aid
    await idx.index(IndexerOptions(**_OPTS))
    src = await _sources()
    assert len(src) == 2, "a copy is a distinct entity, not a silent collapse"
    assert aid in src, "the original keeps its id"
    bid = _fm_id(b)
    assert bid != aid and uuid.UUID(bid).version == 4, "the copy was re-keyed to a fresh v4"
    assert bid in src


@pytest.mark.asyncio
async def test_copy_rekey_is_idempotent(tmp_path: Path) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    shutil.copyfile(a, b)
    await idx.index(IndexerOptions(**_OPTS))
    ids_after_first = set(await _sources())
    b_bytes = b.read_bytes()
    await idx.index(IndexerOptions(**_OPTS, force=True))
    assert set(await _sources()) == ids_after_first, "no third id minted on re-index"
    assert b.read_bytes() == b_bytes, "the copy's capsule is stable (no rekey loop)"


@pytest.mark.asyncio
async def test_receive_exemption_does_not_rekey(tmp_path: Path) -> None:
    idx, a, aid = await _seed_one(tmp_path)
    b = a.with_name("b.md")
    shutil.copyfile(a, b)
    # dedup_on_adopt=False (the bundle-receive/install path): a same-id arrival is
    # intentional, not a copy → NOT re-keyed.
    await idx.index(IndexerOptions(**_OPTS, dedup_on_adopt=False))
    assert _fm_id(b) == aid, "receive path leaves the id untouched"
