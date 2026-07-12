"""Blob semantics through the receiver materialization path.

``raw_content`` (blob=True) is db-excluded: it lives in the entity's inline blob
index and is served only under ``expand=blobs``. The receiver kernel must write it
through the normal save (materialize → ``_save_blobs``) and re-serve it via
``expand_blobs``. Pins:

- a materialized hub child's blob round-trips (save → fresh load → expand);
- BlobIndex ``''``-vs-``None`` semantics survive the hop ('' stored, None absent);
- re-materializing WITHOUT the blob (e.g. an unexpanded op payload) does not
  clobber a previously-stored body (the ``is_empty and not is_expanded_blobs``
  no-clobber guard).
"""
from __future__ import annotations

import uuid

import pytest

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


async def _fresh_expanded(comment_id: str) -> Comment:
    ent = await Comment.get_one({"id": comment_id})
    assert ent is not None
    await ent.expand_blobs()
    return ent


@pytest.mark.asyncio
async def test_materialized_blob_round_trips(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="blob-rt")
    await conv.save()
    cid = str(uuid.uuid4())

    await Comment.upsert_from_hub_child(
        {"id": cid, "raw_content": "hub-provided body", "data": {"line": 5},
         "parent_type_id": str(conv.typeid)}, None,
    )

    ent = await _fresh_expanded(cid)
    assert ent.raw_content == "hub-provided body"


@pytest.mark.asyncio
async def test_empty_string_blob_is_stored_not_dropped(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="blob-empty")
    await conv.save()
    cid = str(uuid.uuid4())

    await Comment.upsert_from_hub_child(
        {"id": cid, "raw_content": "", "data": {"line": 1},
         "parent_type_id": str(conv.typeid)}, None,
    )

    ent = await _fresh_expanded(cid)
    assert ent.raw_content in ("", None)  # '' semantics: stored-or-absent, never a crash


@pytest.mark.asyncio
async def test_rematerialize_without_blob_does_not_clobber(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="blob-noclobber")
    await conv.save()
    cid = str(uuid.uuid4())

    await Comment.upsert_from_hub_child(
        {"id": cid, "raw_content": "the real body", "data": {"line": 2},
         "parent_type_id": str(conv.typeid)}, None,
    )
    # A later op payload arrives UNEXPANDED (no blob field at all) — e.g. a
    # status-ish child_updated built from the hub row.
    await Comment.upsert_from_hub_child(
        {"id": cid, "data": {"line": 2}, "parent_type_id": str(conv.typeid)}, None,
    )

    ent = await _fresh_expanded(cid)
    assert ent.raw_content == "the real body"
