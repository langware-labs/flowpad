"""CRUD × delivery mode × asset type, with git as the transport.

Every change is a commit and every observation comes from a diff — the driver
never walks a directory. Two delivery modes, because the receiving project and
the asset repository are not necessarily the same repo: `none` indexes the
checkout where it sits (one repo), `copy` vendors into the receiving tree (two).
"""
from __future__ import annotations

import pytest

from flow_sdk.ingest.reflect import ReflectMode
from flow_sdk.ingest.sync import sync_source

from ._harness import ASSET_KINDS, FIRST_TOKEN, SECOND_TOKEN, entity_at, id_at, searchable

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MODES = [ReflectMode.NONE.value, ReflectMode.COPY.value]

matrix = pytest.mark.parametrize("kind", ASSET_KINDS, ids=lambda k: k.name)
modes = pytest.mark.parametrize("mode", MODES)


@matrix
@modes
async def test_create(git_db, asset_repo, make_source, mode, kind):
    kind.create(asset_repo)
    source, _project, landing = await make_source(mode)

    await sync_source(source)

    assert await entity_at(landing / kind.rel()) is not None, f"{mode}/{kind.name}: no entity"
    assert await searchable(FIRST_TOKEN), "body did not reach the index"


@matrix
@modes
async def test_update(git_db, asset_repo, make_source, mode, kind):
    """A revision keeps the entity AND refreshes what is searchable."""
    kind.create(asset_repo)
    source, _project, landing = await make_source(mode)
    await sync_source(source)
    before = await id_at(landing / kind.rel())
    assert before is not None

    kind.revise(asset_repo)
    await sync_source(source)

    assert await id_at(landing / kind.rel()) == before, "update forked the entity"
    assert await searchable(SECOND_TOKEN), "new content is not searchable"
    assert not await searchable(FIRST_TOKEN), "stale content still searchable"


@matrix
@modes
async def test_rename(git_db, asset_repo, make_source, mode, kind):
    """`git mv` is reported as a rename, so identity must travel with it.

    This is where git beats the folder source outright: the transport states the
    old/new pair, where an inode heuristic can only guess and an atomic-saving
    editor defeats it.
    """
    kind.create(asset_repo)
    source, _project, landing = await make_source(mode)
    await sync_source(source)
    before = await id_at(landing / kind.rel())
    assert before is not None

    kind.rename(asset_repo)
    await sync_source(source)

    assert await id_at(landing / kind.rel(renamed=True)) == before, "rename forked the entity"


@matrix
@modes
async def test_delete(git_db, asset_repo, make_source, mode, kind):
    kind.create(asset_repo)
    source, _project, landing = await make_source(mode)
    await sync_source(source)
    assert await id_at(landing / kind.rel()) is not None

    kind.remove(asset_repo)
    await sync_source(source)

    assert await entity_at(landing / kind.rel()) is None
    assert not await searchable(FIRST_TOKEN), "deleted content still searchable"
