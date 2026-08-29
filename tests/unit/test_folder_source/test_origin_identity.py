"""Identity comes from the ORIGIN, not from where the bytes were put.

The claim this module exists to prove: once two observations carry the same
origin id, they are consolidated onto one entity. If that holds, the reflect
mode is a placement decision with no bearing on identity — which is what makes
the modes swappable rather than three subtly different products.
"""
from __future__ import annotations

import pytest

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.ingest import reflect
from flow_sdk.ingest.reflect import ReflectMode, origin_id_for

from ._harness import id_at, poll, write_doc

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.mark.parametrize(
    "mode",
    [ReflectMode.NONE.value, ReflectMode.COPY.value, ReflectMode.SYMLINK.value],
)
async def test_re_observing_the_same_origin_keeps_one_entity(
    folder_db, watched, project, make_source, mode
):
    """Seeing the same file again must not mint a second row.

    The cursor is cleared rather than the file touched, so this tests identity
    and not change detection: to the source this is a brand-new observation of
    a file it has never recorded, which is exactly the state a re-scan, a
    replay or a restored backup produces.
    """
    path = write_doc(watched)
    source, _proj = await make_source(mode)
    await poll(source)
    landed = project / "a.md" if mode == ReflectMode.COPY.value else path
    first = await id_at(landed)
    assert first is not None

    from flow_sdk.builtin.data_source_cursor import DataSourceCursor

    cursor = await DataSourceCursor.get_one(
        {"data_source_id": source.id, "segment_key": "root"}
    )
    cursor.state = {}
    await cursor.save()

    await poll(source)

    assert await id_at(landed) == first, f"{mode}: re-observation forked the entity"


@pytest.mark.xfail(
    reason="changing reflect mode leaves the previous placement on disk; the "
           "stale copy is then read as a duplicate occurrence and the re-parse "
           "is discarded. Retiring it would mean deleting a file outside the "
           "currently-configured target, which reflection deliberately refuses.",
    strict=True,
)
async def test_switching_reflect_mode_keeps_one_entity(
    folder_db, watched, project, make_source
):
    """Copy first, then index in place — should stay one row, currently does not."""
    path = write_doc(watched)
    source, _proj = await make_source(ReflectMode.COPY.value)
    await poll(source)
    first = await id_at(project / "a.md")
    assert first is not None

    source.reflect = ReflectMode.NONE.value
    source.reflect_into = ""
    await source.save()

    from flow_sdk.builtin.data_source_cursor import DataSourceCursor

    cursor = await DataSourceCursor.get_one(
        {"data_source_id": source.id, "segment_key": "root"}
    )
    cursor.state = {}
    await cursor.save()

    await poll(source)

    assert await id_at(path) == first, "the same origin produced a second entity"


async def test_the_origin_is_recorded_on_the_row(folder_db, watched, make_source):
    """The handle has to be persisted, or the next poll cannot look it up."""
    path = write_doc(watched)
    source, _proj = await make_source(ReflectMode.NONE.value)

    await poll(source)

    ent = await Entity.get_by_asset_ref(str(path), resolve_containing=True)
    assert ent is not None
    assert ent.origin_id == origin_id_for(source, str(path), await reflect._materialize(source))


async def test_identity_does_not_depend_on_a_capsule_in_the_users_file(
    folder_db, watched, project, make_source
):
    """`copy` must never write into the watched tree.

    The user's folder is an input, not storage. Under copy the capsule belongs
    to our copy; the source file must come back byte-identical to what they
    wrote — and identity still has to survive, which is the origin's job.
    """
    original = "# Alpha\n\nquartzfeather\n"
    path = write_doc(watched, body=original)
    source, _proj = await make_source(ReflectMode.COPY.value)

    await poll(source)

    assert path.read_text(encoding="utf-8") == original, "we wrote into the user's file"
    assert await id_at(project / "a.md") is not None, "identity did not survive"
