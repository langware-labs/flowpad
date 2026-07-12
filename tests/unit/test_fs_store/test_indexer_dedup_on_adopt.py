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

from flow_sdk.fs_store.indexer import IndexerOptions
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS as _OPTS,
    fm_id as _fm_id,
    md_sources as _sources,
    seed_one_md as _seed_one,
)


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
