"""``reflect_refs`` leaves one ``SourceChange`` row per page it applied, and announces it.

The row is the durable form of a folder's change set — the only thing a consumer position can
page — and it keeps the source's intent: added, changed, removed, renamed as observed. The
announcement is ``change.applied``, deliberately NOT ``change.received``: the latter is what
``handle_change`` polls on, and a sync that emitted it would re-poll itself forever.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.source_change import SourceChange
from flow_sdk.ingest.reflect import ReflectMode
from flow_sdk.tags import on_tag

from ._harness import DOC, poll, write_doc

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _rows(source):
    return await SourceChange.page_after(str(source.id), None, limit=50)


@pytest.mark.parametrize("mode", [ReflectMode.NONE.value, ReflectMode.COPY.value])
async def test_create_edit_delete_each_leave_one_row_with_the_right_intent(
    folder_db, watched, project, make_source, mode
):
    path = DOC.create(watched)
    source, _ = await make_source(mode)

    await poll(source)
    (created,) = await _rows(source)
    assert created.added and not created.changed and not created.removed
    landed = created.added[0]
    assert landed.endswith("a.md")
    assert created.origin_ids.get(landed, "").startswith("folder:")

    write_doc(watched, "a.md", "# a\n\nrevised body\n")
    await poll(source)
    rows = await _rows(source)
    assert len(rows) == 2 and rows[1].changed == [landed] and not rows[1].added

    path.unlink()
    await poll(source)
    rows = await _rows(source)
    assert len(rows) == 3 and rows[2].removed == [landed]


async def test_a_quiet_poll_writes_no_row(folder_db, watched, project, make_source):
    """Three polls, two rows: the first indexes, the SECOND sees the identity capsule that
    indexing stamped into the file (a real change to its bytes), the third finds nothing."""
    DOC.create(watched)
    source, _ = await make_source(ReflectMode.NONE.value)
    await poll(source)
    await poll(source)
    assert len(await _rows(source)) == 2
    await poll(source)
    assert len(await _rows(source)) == 2


async def test_the_page_is_announced_as_applied_never_as_received(folder_db, watched, project, make_source):
    DOC.create(watched)
    source, _ = await make_source(ReflectMode.NONE.value)
    applied, received = [], []
    off_a = on_tag("ingest.*.change.applied", lambda e: applied.append(e.data))
    off_r = on_tag("ingest.*.change.received", lambda e: received.append(e.data))
    try:
        await poll(source)
    finally:
        off_a()
        off_r()
    assert applied and applied[0]["source_id"] == str(source.id) and applied[0]["refs"]
    assert received == [], "a sync announcing `received` would re-poll itself"
    # Identity and a locator, never content.
    assert "content" not in applied[0] and "bytes" not in applied[0]


async def test_prune_ages_rows_out_in_bounded_slices(folder_db, watched, project, make_source):
    DOC.create(watched)
    source, _ = await make_source(ReflectMode.NONE.value)
    await poll(source)
    (row,) = await _rows(source)
    row.created_date = datetime.now(timezone.utc) - timedelta(days=40)
    await row.save(notify=False)

    assert await SourceChange.prune_before(datetime.now(timezone.utc) - timedelta(days=30), limit=1) == 1
    assert await _rows(source) == []


async def test_rows_go_with_the_source(folder_db, watched, project, make_source):
    DOC.create(watched)
    source, _ = await make_source(ReflectMode.NONE.value)
    await poll(source)
    assert await _rows(source)
    await source.delete()
    assert await _rows(source) == []
