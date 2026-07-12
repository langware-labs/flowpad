"""Same-path duplicate sweep: one file, many rows → the indexer heals to one.

The real-world producer of this state is a wheel reinstall restoring an INVALID
frontmatter id (e.g. ``id: vibe``) into an installed system asset: every
subsequent index rejects the id, mints a fresh one, and inserts a NEW row —
one duplicate per install. The orphan sweep never fires (the source file still
exists), so the rows accumulate and every asset surface shows N copies.

The sweep is positive-evidence: a parsed file resolves to exactly one id, so
any other pre-existing row anchored to the same path — that nothing else in
the walk claims — is an unreachable duplicate.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS,
    fm_id,
    md_sources,
    seed_one_md,
)


def _reinstall(p: Path, body: str) -> None:
    """Overwrite the file like a wheel reinstall: invalid capsule id + new body."""
    p.write_text(f"---\nid: not-a-valid-uuid\n---\n\n{body}\n", encoding="utf-8")


@pytest.mark.asyncio
async def test_reinstall_dupe_is_swept_on_next_parse(tmp_path: Path) -> None:
    idx, a, first_id = await seed_one_md(tmp_path)

    # "Reinstall" resets the capsule to an invalid id → the next index mints a
    # fresh id and inserts a second row. The sweep can't act yet: at preload
    # time the path had only one row, so there is no duplicate group.
    _reinstall(a, "body v2")
    await idx.index(IndexerOptions(**MD_OPTS))
    src = await md_sources()
    assert len(src) == 2, "the reinstall minted a second row (the bug state)"
    second_id = fm_id(a)
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
    # Both prior rows are unclaimed duplicates now; only the new id survives.
    _reinstall(a, "body v3")
    result = await idx.index(IndexerOptions(**MD_OPTS))
    src = await md_sources()
    assert set(src) == {fm_id(a)}, "an ordinary (non-force) parse heals the path"
    assert result.total_dupes_removed == 2


@pytest.mark.asyncio
async def test_steady_state_is_untouched(tmp_path: Path) -> None:
    """A healthy file re-parsed under force resolves its own id — nothing removed."""
    idx, a, aid = await seed_one_md(tmp_path)
    result = await idx.index(IndexerOptions(**MD_OPTS, force=True))
    assert set(await md_sources()) == {aid}
    assert result.total_dupes_removed == 0
