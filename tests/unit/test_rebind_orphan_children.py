"""Orphan rebind: children synced before their parent materialized get their edge.

A remote child row can land while its real parent (a layer-1-gated shared doc) is
still absent; the ``is_stale`` LWW skip means the row never re-materializes, so
``_rebind_orphan_children`` (run by every ``_sync_shared_context_subtree`` pass) is
the only healer. Covers: orphan + late parent → linked; already-linked → no-op
(single edge); non-remote local rows untouched.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.app.actions.flow_message_action import _rebind_orphan_children
from flow_sdk.builtin.comment import Comment
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


@pytest.fixture()
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


@pytest.fixture()
def blob_storage(tmp_path):
    """Blob-storage fallback so Comment (blob field) saves outside a service context."""
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


async def _child_ids(parent) -> list[str]:
    kids = await parent.get_children()
    return [getattr(k, "value", k).id for k in kids if getattr(k, "value", k) is not None]


@pytest.mark.asyncio
async def test_orphan_linked_once_parent_materializes(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="rebind-conv")
    await conv.save()
    doc_ref = f"conversation-{uuid.uuid4()}"  # the "doc": absent at child-sync time

    # Child lands first (parent absent → no edge; kernel tolerates it).
    orphan = await Comment.upsert_from_hub_child(
        {"id": str(uuid.uuid4()), "raw_content": "late-bind", "data": {"line": 2},
         "parent_type_id": doc_ref}, None,
    )

    # Parent materializes later (bundle install equivalent) and is a shared-context doc.
    parent = Conversation(id=doc_ref.split("-", 1)[1], title="the-doc")
    await parent.save()
    assert await _child_ids(parent) == []  # still orphaned

    conv.add_shared_context_entities(parent.typeid)
    await _rebind_orphan_children(conv, 'comment', None)

    assert await _child_ids(parent) == [orphan.id]


@pytest.mark.asyncio
async def test_rebind_is_noop_when_already_linked(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="rebind-noop")
    await conv.save()
    ent = await Comment.upsert_from_hub_child(
        {"id": str(uuid.uuid4()), "raw_content": "x", "data": {"line": 1},
         "parent_type_id": str(conv.typeid)}, None,
    )
    assert await _child_ids(conv) == [ent.id]

    await _rebind_orphan_children(conv, 'comment', None)
    await _rebind_orphan_children(conv, 'comment', None)

    ids = await _child_ids(conv)
    assert ids.count(ent.id) == 1


@pytest.mark.asyncio
async def test_rebind_skips_non_remote_rows(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="rebind-local")
    await conv.save()
    local = Comment(
        id=str(uuid.uuid4()), raw_content="local-only", data={"line": 1},
        parent_type_id=str(conv.typeid),
    )
    await local.save()  # locally-authored, remote=False, deliberately no edge here

    await _rebind_orphan_children(conv, 'comment', None)

    assert await _child_ids(conv) == []  # untouched: rebind only heals remote rows
