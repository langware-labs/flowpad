"""The matrix: CRUD × delivery mode × asset type.

Three axes, crossed deliberately rather than sampled, because the whole claim
being tested is that they are INDEPENDENT — what you do to a file, where its
bytes are delivered, and whether it is a file-layout or folder-layout asset
should compose, not interact.

Where a cell does interact, that is a finding and it gets a name here rather
than a paragraph somewhere else.
"""
from __future__ import annotations

import pytest

from flow_sdk.ingest.reflect import ReflectMode

from ._harness import (
    ASSET_KINDS,
    FIRST_TOKEN,
    SECOND_TOKEN,
    entity_at,
    id_at,
    poll,
    searchable,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MODES = [ReflectMode.NONE.value, ReflectMode.COPY.value, ReflectMode.SYMLINK.value]

#: `copy` is the only mode that relocates bytes. `symlink` places a link but the
#: indexer resolves through it, so the entity keys on the source — it lands with
#: `none`, not with `copy`. Pinned by `test_symlink_indexes_at_the_target`.
def _landed(mode, watched, project, kind, *, renamed=False):
    root = project if mode == ReflectMode.COPY.value else watched
    return root / kind.rel(renamed=renamed)


matrix = pytest.mark.parametrize(
    "kind", ASSET_KINDS, ids=lambda k: k.name
)
modes = pytest.mark.parametrize("mode", MODES)


@matrix
@modes
async def test_create(folder_db, watched, project, make_source, mode, kind):
    """Authoring an asset makes it exist and makes its body findable."""
    kind.create(watched)
    source, _proj = await make_source(mode)

    await poll(source)

    assert await entity_at(_landed(mode, watched, project, kind)) is not None
    assert await searchable(FIRST_TOKEN, kind.record_type), "body did not reach the index"


@matrix
@modes
async def test_update(folder_db, watched, project, make_source, mode, kind):
    """A revision keeps the entity AND refreshes what is searchable.

    Asserting the id alone would pass on a stale index — same row, old content.
    The old token must stop matching and the new one must start.
    """
    kind.create(watched)
    source, _proj = await make_source(mode)
    await poll(source)
    before = await id_at(_landed(mode, watched, project, kind))
    assert before is not None

    kind.revise(watched)
    await poll(source)

    assert await id_at(_landed(mode, watched, project, kind)) == before, "update forked the entity"
    assert await searchable(SECOND_TOKEN, kind.record_type), "new content is not searchable"
    assert not await searchable(FIRST_TOKEN, kind.record_type), "stale content still searchable"


@matrix
@modes
async def test_rename(folder_db, watched, project, make_source, mode, kind):
    """A move is not a delete-and-create — identity has to survive it."""
    kind.create(watched)
    source, _proj = await make_source(mode)
    await poll(source)
    before = await id_at(_landed(mode, watched, project, kind))
    assert before is not None

    kind.rename(watched)
    await poll(source)

    after = await id_at(_landed(mode, watched, project, kind, renamed=True))
    assert after == before, "rename forked the entity instead of moving it"


@matrix
@modes
async def test_delete(folder_db, watched, project, make_source, mode, kind):
    """Removal has to reach the index, not just the row.

    A surviving FTS entry is the failure users actually report: an answer that
    cites a document which no longer exists.
    """
    kind.create(watched)
    source, _proj = await make_source(mode)
    await poll(source)
    assert await id_at(_landed(mode, watched, project, kind)) is not None

    kind.remove(watched)
    await poll(source)

    assert await entity_at(_landed(mode, watched, project, kind)) is None
    assert not await searchable(FIRST_TOKEN, kind.record_type), "deleted content still searchable"
