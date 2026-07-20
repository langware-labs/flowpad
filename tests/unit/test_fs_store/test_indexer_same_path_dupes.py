"""Same-path duplicate sweep: one file, many rows → the indexer heals to one.

A legacy wheel reinstall can replace the whole file, dropping its comment
capsule and restoring an invalid frontmatter id. The new policy resolves that
state to one stable path-v5 without rewriting the invalid bytes. This suite
keeps the same-path DB reconciliation behavior pinned across that transition.

The sweep is positive-evidence: a parsed file resolves to exactly one id, so
any other pre-existing row anchored to the same path — that nothing else in
the walk claims — is an unreachable duplicate.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS,
    md_sources,
    seed_one_md,
)


def _reinstall(p: Path, body: str) -> None:
    """Overwrite the file like a wheel reinstall: invalid capsule id + new body."""
    p.write_text(f"---\nid: not-a-valid-uuid\n---\n\n{body}\n", encoding="utf-8")


@pytest.mark.asyncio
async def test_reinstall_dupe_is_swept_on_next_parse(tmp_path: Path) -> None:
    idx, a, first_id = await seed_one_md(tmp_path)

    # "Reinstall" drops the canonical capsule and restores an invalid legacy id.
    # The next index uses stable path-v5 and inserts a second row. The sweep
    # can't act yet: at preload
    # time the path had only one row, so there is no duplicate group.
    _reinstall(a, "body v2")
    await idx.index(IndexerOptions(**MD_OPTS))
    src = await md_sources()
    assert len(src) == 2, "the reinstall minted a second row (the bug state)"
    second_id = SchemaRegistry.get("markdown").mint_id(FSRef(a))
    assert second_id in src and first_id in src

    # Force reindex: the file is parsed, resolves to its stamped id, and the
    # stale first row — same path, claimed by nothing — is removed.
    result = await idx.index(IndexerOptions(**MD_OPTS, force=True))
    src = await md_sources()
    assert set(src) == {second_id}, "the stale duplicate row was swept"
    assert result.total_dupes_removed == 1
    assert result.per_type[RecordType.MARKDOWN].dupes_removed == 1


@pytest.mark.asyncio
async def test_upgrade_parse_heals_without_force(tmp_path: Path) -> None:
    idx, a, first_id = await seed_one_md(tmp_path)
    _reinstall(a, "body v2")
    await idx.index(IndexerOptions(**MD_OPTS))
    assert len(await md_sources()) == 2

    # The NEXT reinstall changes the file (hash moves) → parsed without force.
    # The stable-v5 row is selected again; the prior v4 row is now unreachable.
    _reinstall(a, "body v3")
    result = await idx.index(IndexerOptions(**MD_OPTS))
    src = await md_sources()
    stable_id = SchemaRegistry.get("markdown").mint_id(FSRef(a))
    assert set(src) == {stable_id}, "an ordinary (non-force) parse heals the path"
    assert result.total_dupes_removed == 1


@pytest.mark.asyncio
async def test_steady_state_is_untouched(tmp_path: Path) -> None:
    """A healthy file re-parsed under force resolves its own id — nothing removed."""
    idx, a, aid = await seed_one_md(tmp_path)
    result = await idx.index(IndexerOptions(**MD_OPTS, force=True))
    assert set(await md_sources()) == {aid}
    assert result.total_dupes_removed == 0
