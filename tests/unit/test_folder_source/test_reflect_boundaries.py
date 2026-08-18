"""The boundaries themselves — asserted, not just documented.

A reflector that quietly minted a row would still make every functional test in
this package pass. These are the tests that would fail instead, which is why
they exist as their own module rather than as extra asserts elsewhere.
"""
from __future__ import annotations

import pytest

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.ingest.driver import get_driver
from flow_sdk.ingest.reflect import (
    ReflectMode,
    get_reflector,
    reflect_refs,
)

from ._harness import poll, write_doc

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

ALL_MODES = [ReflectMode.NONE.value, ReflectMode.COPY.value, ReflectMode.SYMLINK.value]


@pytest.mark.parametrize("mode", ALL_MODES)
async def test_placement_alone_writes_nothing_to_the_graph(
    folder_db, watched, project, make_source, mode
):
    """A reflector places bytes. It does not touch the graph.

    Calling ``place`` directly must leave the database exactly as it was — the
    entity only appears once ``reflect_refs`` has handed the path on to
    ``reindex_paths``. That split is the boundary; without this test it is a
    comment.
    """
    path = write_doc(watched)
    source, _project = await make_source(mode)
    reflector = get_reflector(mode)

    placed = reflector.place(source, str(path))

    assert placed, "nothing was placed"
    assert await Entity.get_by_asset_ref(str(path), resolve_containing=True) is None
    assert await Entity.get_by_asset_ref(str(placed), resolve_containing=True) is None

    # …and the same call through the layer DOES produce one.
    await reflect_refs(source, [str(path)], [])
    assert await Entity.get_by_asset_ref(str(placed), resolve_containing=True) is not None


async def test_the_driver_produces_refs_and_never_items(folder_db, watched, make_source):
    """The folder driver's payload is files, so it must not mint SourceItems.

    ``ingest_items`` stays the single chokepoint for ``SourceItem`` writes. A
    file source that emitted items would route filesystem assets through the
    message path and land them in the inbox projection's neighbourhood, which is
    the failure this separation exists to prevent.
    """
    from flow_sdk.ingest.driver import SegmentCursorView

    write_doc(watched)
    source, _project = await make_source(ReflectMode.NONE.value)
    driver = get_driver("folder")

    result = await driver.fetch(source, SegmentCursorView(segment_key="root", state={}))

    assert result.refs, "driver produced no refs"
    assert result.items == [], "a file source must not produce IngestItems"
    assert driver.record_kind == "", "a file source has no record kind to stamp"


async def test_record_mode_never_reaches_the_reflector(folder_db, watched, make_source):
    """`record` is the other destination, not a reflector.

    There is deliberately no reflector registered for it: a source asking for
    `record` takes the `ingest_items` path, and a lookup that silently returned
    an in-place reflector instead would route file assets into the graph as rows.
    """
    assert get_reflector(ReflectMode.RECORD.value) is None


async def test_polling_converges_to_quiet(folder_db, watched, make_source):
    """The idempotence the design leans on INSTEAD of a debounce.

    It does NOT settle on the second pass, and the reason is worth knowing:
    indexing a portable asset STAMPS an identity capsule into the file's own
    frontmatter, so the first pass rewrites the very file it just read. mtime
    and size move, and the source honestly reports its own write as a change.

    So the guarantee is convergence, not immediate silence — the stamp is
    written once, the next pass finds the capsule already present and rewrites
    nothing, and the manifest goes quiet. That is enough for the no-debounce
    decision (a burst of editor events costs one real pass plus one confirming
    pass, not N), but a caller expecting pass two to be free would be wrong.
    """
    write_doc(watched)
    source, _project = await make_source(ReflectMode.NONE.value)

    from flow_sdk.builtin.data_source_cursor import DataSourceCursor
    from flow_sdk.ingest.driver import SegmentCursorView

    driver = get_driver("folder")

    async def probe_is_quiet() -> bool:
        cursor = await DataSourceCursor.get_one(
            {"data_source_id": source.id, "segment_key": "root"}
        )
        assert cursor is not None and cursor.state, "poll left no manifest"
        result = await driver.fetch(
            source, SegmentCursorView(segment_key="root", state=dict(cursor.state))
        )
        return result.unchanged and not result.refs and not result.tombstones

    # Bounded, and the bound is the point: if this ever needs more passes,
    # something is rewriting the file on every index and the loop never closes.
    for _ in range(3):
        await poll(source)
        if await probe_is_quiet():
            return
    raise AssertionError("polling never went quiet — an index pass keeps mutating the file")
