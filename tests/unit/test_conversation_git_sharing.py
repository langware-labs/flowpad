"""Conversation-scoped ``git_sharing_enabled`` — the hub-synced default that
remembers whether asset shares ride Git origins or copied bytes.

Model-level guarantees the sync/fanout paths depend on:
  * defaults OFF for a new conversation (copy),
  * is an API field (so the hub's generic update accepts it and
    ``_upsert_hub_conversation_metadata`` / ``_handle_conversation_op`` copy it),
  * rides the wire payload (so the hub's ``_fanout_self_update`` — a
    ``model_dump`` — carries it to every participant).
"""

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.cloud_client.hub_bridge import HubWsBridge, _conversation_allows_inbound_materialization
from flow_sdk.utils import hub as hub_utils

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def test_defaults_off_for_new_conversation():
    assert Conversation().git_sharing_enabled is False


def test_is_api_field_so_hub_update_and_sync_accept_it():
    # The hub's generic update filters non-API fields; sync copy-loops read it.
    assert Conversation.is_api_field("git_sharing_enabled") is True


def test_rides_wire_payload_for_participant_fanout():
    dump = Conversation(git_sharing_enabled=True).model_dump(mode="json")
    assert dump.get("git_sharing_enabled") is True


def test_roundtrips_through_model_validate():
    conv = Conversation.model_validate({"id": mint_uuid(), "git_sharing_enabled": True})
    assert conv.git_sharing_enabled is True


def test_bridge_conversation_tombstone_is_process_local_and_sticky():
    conv_id = mint_uuid()
    bridge = HubWsBridge()
    bridge.remember_hub_conversation(conv_id)

    bridge.suppress_conversation_materialization(conv_id)

    assert bridge.conversation_materialization_suppressed(conv_id) is True
    assert bridge.is_hub_conversation(conv_id) is False
    bridge.remember_hub_conversation(conv_id)
    assert bridge.conversation_materialization_suppressed(conv_id) is True


@pytest.mark.asyncio
async def test_inbound_materialization_rejects_deleted_parent_but_recovers_missed_assignment(monkeypatch):
    conv_id = mint_uuid()

    async def no_local_parent(query):
        assert query == {"id": conv_id}
        return None

    monkeypatch.setattr(Conversation, "get_one", no_local_parent)

    async def deleted_parent(*args, **kwargs):
        return {"id": conv_id, "deleted_at": "2026-08-02T00:00:00Z"}

    monkeypatch.setattr(hub_utils, "hub_get", deleted_parent)
    assert await _conversation_allows_inbound_materialization(conv_id) is False

    async def live_assigned_parent(*args, **kwargs):
        return {"id": conv_id, "deleted_at": None}

    monkeypatch.setattr(hub_utils, "hub_get", live_assigned_parent)
    assert await _conversation_allows_inbound_materialization(conv_id) is True


@pytest.mark.asyncio
async def test_hub_bridge_create_and_update_mark_conversation_remote():
    """Hub ingest owns the remote-mirror invariant, even without an accept event."""
    conv_id = mint_uuid()
    bridge = HubWsBridge()

    await bridge._handle_conversation_op(
        "create",
        conv_id,
        {"id": conv_id, "title": "Assigned conversation"},
    )
    created = await Conversation.get_one({"id": conv_id})
    assert created is not None
    assert created.remote is True

    created.remote = False
    await created.save(notify=False)
    await bridge._handle_conversation_op(
        "update",
        conv_id,
        {"id": conv_id, "title": "Updated assigned conversation"},
    )
    updated = await Conversation.get_one({"id": conv_id})
    assert updated is not None
    assert updated.remote is True
