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

from flow_sdk.builtin.conversation import Conversation

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
    conv = Conversation.model_validate({"id": "c-1", "git_sharing_enabled": True})
    assert conv.git_sharing_enabled is True
