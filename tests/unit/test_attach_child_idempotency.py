"""attach_child idempotency — the receiver kernel's edge-creation guard rests on this.

``add_child`` = ``child.save()`` + ``attach_child`` → ``grant_role(is_child=True)``.
The hub-children materialization kernel (``Entity.upsert_from_hub_child``) re-runs on
every live op AND every catch-up pull, so a second attach of the same (parent, child)
pair must not mint a duplicate relationship row — one edge, exactly, no matter how many
times the kernel converges the same child.
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
    """Blob-storage fallback so Comment (blob field) saves outside a service context —
    same hook ``get_embedded_storage`` falls back to (test_spec_bundle_unpack pattern)."""
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


@pytest.mark.asyncio
async def test_attach_child_twice_yields_single_edge(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="p2-dedup")
    await conv.save()
    child = Comment(id=str(uuid.uuid4()), raw_content="x", data={"line": 1})
    await conv.add_child(child)
    await conv.attach_child(child)  # kernel re-convergence path

    kids = await conv.get_children()
    ids = [getattr(k, "value", k).id for k in kids if getattr(k, "value", k) is not None]
    assert ids.count(child.id) == 1, f"expected exactly one edge, got {ids.count(child.id)}"
