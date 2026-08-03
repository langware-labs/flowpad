"""Removing a child announces it, and actually removes it from the projection.

``attach_child`` announces CHILD_CREATED; ``detach_child`` is its mirror. Both
halves matter now that membership IS the edge:

  * a watcher of the parent must learn the subtree shrank, not just that it grew;
  * and removal must drop the EDGE — pruning only the jsonl pointer leaves the
    message in the projection, because the projection is derived from edges.
    That second one is a regression the edge model introduces, so it is pinned
    here rather than left to be discovered.

Generic on purpose: ``Comment`` children, nothing message-specific.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.comment import Comment
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.tags import on_tag


@pytest.fixture()
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


@pytest.fixture()
def blob_storage(tmp_path):
    from flow_sdk.config import default_service_config
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev


class _Tags:
    def __init__(self, parent_id: str):
        self.parent_id = parent_id
        self.tags: list[str] = []
        self._off = on_tag("entity.*", self._rec)

    def _rec(self, event) -> None:
        if self.parent_id in str(event.target):
            self.tags.append(event.tag)

    def stop(self) -> list[str]:
        self._off()
        return self.tags


async def _parent_with_child():
    conv = Conversation(id=str(uuid.uuid4()), title="detach")
    await conv.save()
    child = Comment(id=str(uuid.uuid4()), raw_content="x", data={"line": 1})
    await child.save()
    await conv.attach_child(child, notify=False)
    return conv, child


@pytest.mark.asyncio
async def test_detach_announces_child_deleted(records_root, blob_storage):
    conv, child = await _parent_with_child()

    watcher = _Tags(conv.id)
    try:
        removed = await conv.detach_child(child.typeid)
    finally:
        tags = watcher.stop()

    assert removed, "precondition: the edge should have been removed"
    assert any("child_deleted" in t for t in tags), f"expected a child_deleted tag, got {tags}"


@pytest.mark.asyncio
async def test_detaching_a_non_child_is_silent(records_root, blob_storage):
    """No edge removed → nothing changed → nothing announced."""
    conv, _ = await _parent_with_child()
    stranger = Comment(id=str(uuid.uuid4()), raw_content="y", data={"line": 2})
    await stranger.save()

    watcher = _Tags(conv.id)
    try:
        removed = await conv.detach_child(stranger.typeid)
    finally:
        tags = watcher.stop()

    assert removed == 0
    assert tags == [], f"detaching a non-child must emit nothing, got {tags}"


@pytest.mark.asyncio
async def test_notify_false_suppresses_the_announcement(records_root, blob_storage):
    conv, child = await _parent_with_child()

    watcher = _Tags(conv.id)
    try:
        await conv.detach_child(child.typeid, notify=False)
    finally:
        tags = watcher.stop()

    assert tags == [], f"notify=False must emit nothing, got {tags}"
    assert await conv._has_child_edge(child) is False, "the edge should still be gone"


@pytest.mark.asyncio
async def test_detach_removes_it_from_the_child_set(records_root, blob_storage):
    """The edge is membership — detaching must actually drop it."""
    conv, child = await _parent_with_child()
    assert await conv._has_child_edge(child) is True

    await conv.detach_child(child.typeid, notify=False)

    kids = await conv.get_children()
    ids = [getattr(k, "value", k).id for k in kids if getattr(k, "value", k) is not None]
    assert child.id not in ids, f"detached child still in the child set: {ids}"
