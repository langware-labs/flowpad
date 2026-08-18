"""The invariants that define a git source, asserted rather than described."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.ingest.change_event import change_tag, emit_change, handle_change, subscribe
from flow_sdk.ingest.driver import StreamCursorView, get_driver
from flow_sdk.ingest.reflect import ReflectMode, origin_id_for
from flow_sdk.ingest.sync import sync_source
from flow_sdk.utils.git import git_remote_url

from ._harness import DOC, FIRST_TOKEN, entity_at, searchable
from .conftest import commit, git

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_the_working_tree_stays_clean(git_db, asset_repo, make_source):
    """Indexing must not write into a tracked file.

    A capsule stamped into the working tree is committed and pushed, so our
    metadata reaches every collaborator who pulls. Identity comes from the
    `origin_id` lookup precisely so this assertion can hold.
    """
    DOC.create(asset_repo)
    source, _project, _landing = await make_source(ReflectMode.IN_PLACE.value)

    await sync_source(source)

    assert git(asset_repo, "status", "--porcelain") == "", "indexing dirtied the repo"


async def test_the_driver_never_walks_the_filesystem(git_db, asset_repo, make_source, monkeypatch):
    """Change comes from the transport, not from enumerating a directory.

    A git driver that walks is a folder source wearing a git hat — and it would
    lose exactly what git is here to provide: exact deletions and real renames.
    """
    DOC.create(asset_repo)
    source, _project, _landing = await make_source(ReflectMode.IN_PLACE.value)

    walked: list[str] = []
    import os as _os

    real_walk = _os.walk
    monkeypatch.setattr(_os, "walk", lambda *a, **k: (walked.append(str(a[0])), real_walk(*a, **k))[1])

    await get_driver("git").fetch(source, StreamCursorView(stream_key="main", state={}))

    assert walked == [], f"the driver walked: {walked}"


async def test_origin_id_is_the_documented_dedup_handle(git_db, asset_repo, make_source):
    """`origin_id` must BE `GitOrigin.key()`, not something parallel to it.

    That key is frozen, pinned by `tests/unit/test_fs_origin.py`, and already a
    live Folder id. A git source inventing its own handle would fork identity
    from everything that already reconciles on this one.
    """
    DOC.create(asset_repo)
    source, _project, landing = await make_source(ReflectMode.IN_PLACE.value)
    await sync_source(source)

    expected = GitOrigin.from_url(git_remote_url(str(asset_repo)), rel_path="a.md")
    entity = await entity_at(landing / "a.md")

    assert entity is not None
    assert entity.origin_id == str(expected.key())
    assert origin_id_for(source, str(asset_repo / "a.md")) == str(expected.key())


async def test_an_empty_event_still_reconciles(git_db, asset_repo, make_source):
    """A lossy or payload-free event must not mean lost data.

    Drive's watch carries no detail at all, so the receiver has to be able to
    recover from a bare nudge. For git that recovery is exact: diff the cursor's
    sha against HEAD.
    """
    source, _project, landing = await make_source(ReflectMode.IN_PLACE.value)
    await sync_source(source)
    DOC.create(asset_repo)  # committed AFTER the source last synced

    handled = await handle_change(
        type("E", (), {"data": {"source_id": str(source.id), "provider": "git"}})()
    )

    assert handled is True
    assert await entity_at(landing / "a.md") is not None, "empty event did not reconcile"
    assert await searchable(FIRST_TOKEN)


async def test_the_bus_reaches_the_handler(git_db, asset_repo, make_source):
    """The subscription connects — nothing more.

    The bus does not await async consumers (`emit` never blocks on a handler),
    so asserting an OUTCOME here would race a detached task. What must be
    proven is that an emitted event matches the pattern and is dispatched; the
    matrix drives `handle_change` directly for everything else.
    """
    source, _project, _landing = await make_source(ReflectMode.IN_PLACE.value)
    seen: list[str] = []

    from flow_sdk.tags import on_tag

    unsub = on_tag(f"ingest.*.change.received", lambda e: seen.append(e.data.get("source_id")))
    try:
        emit_change(str(source.id), "git", reason="test")
    finally:
        unsub()

    assert seen == [str(source.id)]
    assert change_tag("git") == "ingest.git.change.received"


async def test_subscribe_returns_a_working_unsubscriber(git_db):
    """Lifetime is the caller's job — a leaked subscription outlives its test."""
    unsub = subscribe()
    assert callable(unsub)
    unsub()
