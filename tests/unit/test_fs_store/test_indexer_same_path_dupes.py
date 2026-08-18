"""Same-path identity: one file resolves to one row, and dirty rows are swept.

Two halves, and they are NOT the same thing:

1. **Never fork.** A source whose identity carrier is gone or unreadable — a
   wheel reinstall restoring an invalid frontmatter id, an agent rewriting a doc
   wholesale — must resolve to the row that already owns its path. It used to
   mint a fresh id and insert a second row, then rely on the sweep to clean up
   after itself; in between, every reference pinned to the original id pointed at
   a row about to be deleted.

2. **Still sweep.** Rows forked before that fix, or written by anything else,
   still have to be reconciled. The sweep is positive-evidence: a parsed file
   resolves to exactly one id, so any OTHER pre-existing row anchored to the same
   path — that nothing in the walk claims — is an unreachable duplicate.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.unit.test_fs_store._identity_invariants import assert_one_live_row_per_path
from tests.unit.test_fs_store._md_harness import (
    MD_OPTS,
    md_sources,
    seed_one_md,
)


def _reinstall(p: Path, body: str) -> None:
    """Overwrite the file like a wheel reinstall: invalid capsule id + new body."""
    p.write_text(f"---\nid: not-a-valid-uuid\n---\n\n{body}\n", encoding="utf-8")


def _wipe(p: Path, body: str) -> None:
    """Overwrite like a real agent revision: the identity capsule is simply gone."""
    p.write_text(f"# a\n\n{body}\n", encoding="utf-8")


async def _forge_duplicate_row(path: Path, entity_id: str) -> None:
    """Insert a SECOND row for ``path`` behind the walk's back.

    Reproduces a pre-fix / legacy DB without re-introducing the fork: identity
    resolution can no longer produce this state, so the sweep's own coverage
    has to construct it directly.
    """
    cls = SchemaRegistry.get_entity_cls("markdown")
    entity = cls(id=entity_id, name="forged-duplicate", asset_ref=str(path))
    await entity.save()
    assert entity_id in await md_sources(), "the forged duplicate row must exist"


@pytest.mark.asyncio
async def test_reinstall_keeps_the_owner_row_and_never_forks(tmp_path: Path) -> None:
    """An invalid carrier yields to the row that owns the path — and keeps its bytes."""
    idx, a, first_id = await seed_one_md(tmp_path)

    _reinstall(a, "body v2")
    before = a.read_bytes()
    result = await idx.index(IndexerOptions(**MD_OPTS))

    assert set(await md_sources()) == {first_id}, "the reinstall must not mint a second row"
    assert result.total_dupes_removed == 0, "nothing to sweep — nothing forked"
    # INVALID is not ABSENT: `mint_id` never overwrites invalid canonical data,
    # and neither may the owner-first path.
    assert a.read_bytes() == before, "invalid carrier bytes must not be rewritten"
    await assert_one_live_row_per_path("markdown")


@pytest.mark.asyncio
async def test_capsule_wipe_keeps_the_owner_row_and_restamps(tmp_path: Path) -> None:
    """The real bug: an agent rewrites the doc, wiping the capsule entirely."""
    idx, a, first_id = await seed_one_md(tmp_path)

    _wipe(a, "rewritten by the agent")
    assert "flowpad:capsule" not in a.read_text(encoding="utf-8")
    result = await idx.index(IndexerOptions(**MD_OPTS))

    assert set(await md_sources()) == {first_id}, "a rewritten doc keeps its entity"
    assert result.total_dupes_removed == 0
    # ABSENT carrier → healed in place, so the next walk agrees without the DB.
    assert SchemaRegistry.get("markdown").mint_entity_id(FSRef(a)) == first_id
    await assert_one_live_row_per_path("markdown")


@pytest.mark.asyncio
async def test_repeated_reinstalls_never_accumulate_rows(tmp_path: Path) -> None:
    """Three revisions in a row — the shape that put 4 ids on one prod doc."""
    idx, a, first_id = await seed_one_md(tmp_path)

    for body in ("body v2", "body v3", "body v4"):
        _reinstall(a, body)
        await idx.index(IndexerOptions(**MD_OPTS))
        assert set(await md_sources()) == {first_id}, f"forked while writing {body!r}"

    await assert_one_live_row_per_path("markdown")


@pytest.mark.asyncio
async def test_steady_state_is_untouched(tmp_path: Path) -> None:
    """A healthy file re-parsed under force resolves its own id — nothing removed."""
    idx, a, aid = await seed_one_md(tmp_path)
    result = await idx.index(IndexerOptions(**MD_OPTS, force=True))
    assert set(await md_sources()) == {aid}
    assert result.total_dupes_removed == 0
    await assert_one_live_row_per_path("markdown")


@pytest.mark.asyncio
async def test_preexisting_duplicate_row_is_still_swept(tmp_path: Path) -> None:
    """Rows forked BEFORE the fix (or by anything else) still get reconciled."""
    idx, a, first_id = await seed_one_md(tmp_path)
    stale_id = str(uuid.uuid4())
    await _forge_duplicate_row(a, stale_id)
    assert set(await md_sources()) == {first_id, stale_id}

    result = await idx.index(IndexerOptions(**MD_OPTS, force=True))

    assert set(await md_sources()) == {first_id}, "the stale duplicate row was swept"
    assert result.total_dupes_removed == 1
    assert result.per_type[RecordType.MARKDOWN].dupes_removed == 1
    await assert_one_live_row_per_path("markdown")


@pytest.mark.asyncio
async def test_forked_rows_converge_on_one_deterministic_owner(tmp_path: Path) -> None:
    """A dirty DB self-heals: every walk picks the SAME survivor, then sweeps."""
    idx, a, first_id = await seed_one_md(tmp_path)
    for _ in range(2):
        await _forge_duplicate_row(a, str(uuid.uuid4()))
    assert len(await md_sources()) == 3

    _wipe(a, "rewritten while the DB was already forked")
    await idx.index(IndexerOptions(**MD_OPTS, force=True))

    survivors = set(await md_sources())
    assert len(survivors) == 1, "a forked path must collapse to exactly one row"
    await assert_one_live_row_per_path("markdown")
