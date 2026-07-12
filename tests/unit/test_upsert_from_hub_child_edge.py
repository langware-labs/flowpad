"""Receiver kernel contract: ``upsert_from_hub_child`` recreates the parent edge.

The sender's create ran ``add_child`` → a local ``is_child`` role edge, and the
UI's role-walk scope queries resolve through that edge. The receiver's
materialization must replay the same write:

- parent row present locally  → edge created (child visible to scope queries);
- parent row absent           → row saved, no edge, no raise (rebind heals later);
- re-materialization (every live op / catch-up pass) → still exactly one edge;
- the child payload's own ``parent_type_id`` wins over the hub-container envelope.
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


async def _child_ids(parent) -> list[str]:
    kids = await parent.get_children()
    return [getattr(k, "value", k).id for k in kids if getattr(k, "value", k) is not None]


def _payload(parent_ref: str | None = None, **extra) -> dict:
    p = {"id": str(uuid.uuid4()), "raw_content": "hub body", "data": {"line": 3}, **extra}
    if parent_ref:
        p["parent_type_id"] = parent_ref
    return p


@pytest.mark.asyncio
async def test_edge_created_when_parent_present(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="edge-parent-present")
    await conv.save()

    ent = await Comment.upsert_from_hub_child(_payload(str(conv.typeid)), None)

    assert ent.remote is True
    assert await _child_ids(conv) == [ent.id]


@pytest.mark.asyncio
async def test_no_edge_and_no_raise_when_parent_absent(records_root, blob_storage):
    ghost_parent = f"markdown-{uuid.uuid4()}"  # never materialized locally

    ent = await Comment.upsert_from_hub_child(_payload(ghost_parent), None)

    assert ent.parent_type_id == ghost_parent  # pointer preserved for the rebind pass
    assert await ent.ensure_child_edge() is False  # still unlinkable — parent absent


@pytest.mark.asyncio
async def test_rematerialization_keeps_single_edge(records_root, blob_storage):
    conv = Conversation(id=str(uuid.uuid4()), title="edge-idempotent")
    await conv.save()
    payload = _payload(str(conv.typeid))

    await Comment.upsert_from_hub_child(payload, None)
    await Comment.upsert_from_hub_child(payload, None)  # live op + catch-up overlap

    ids = await _child_ids(conv)
    assert ids.count(payload["id"]) == 1


@pytest.mark.asyncio
async def test_payload_parent_wins_over_envelope(records_root, blob_storage):
    doc_parent = Conversation(id=str(uuid.uuid4()), title="real-parent")
    await doc_parent.save()
    envelope_parent = Conversation(id=str(uuid.uuid4()), title="hub-container")
    await envelope_parent.save()

    ent = await Comment.upsert_from_hub_child(
        _payload(str(doc_parent.typeid)), str(envelope_parent.typeid)
    )

    assert ent.parent_type_id == str(doc_parent.typeid)
    assert await _child_ids(doc_parent) == [ent.id]
    assert await _child_ids(envelope_parent) == []
