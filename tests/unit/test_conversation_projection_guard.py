"""Phase 1: Conversation projection guard.

`message_ids` and `message_count` are projections written only by
`ConversationRecord.sync_to_db`. Direct mutation by application code raises.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.conversation import Conversation, _PROJECTION_SENTINEL


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_direct_assignment_to_message_ids_raises():
    conv = Conversation.model_validate({"id": "abc12345-1234-1234-1234-123456789012"})
    with pytest.raises(AttributeError, match="projection"):
        conv.message_ids = "[]"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_direct_assignment_to_message_count_raises():
    conv = Conversation.model_validate({"id": "abc12345-1234-1234-1234-123456789012"})
    with pytest.raises(AttributeError, match="projection"):
        conv.message_count = 5


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_projection_sentinel_allows_write():
    conv = Conversation.model_validate({"id": "abc12345-1234-1234-1234-123456789012"})
    conv._set_projection("message_count", 3, _PROJECTION_SENTINEL)
    conv._set_projection("message_ids", '[{"typeid":"flow_message-x","ts":"t"}]', _PROJECTION_SENTINEL)
    assert conv.message_count == 3
    assert conv.message_ids == '[{"typeid":"flow_message-x","ts":"t"}]'


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_invalid_sentinel_rejected():
    conv = Conversation.model_validate({"id": "abc12345-1234-1234-1234-123456789012"})
    with pytest.raises(PermissionError):
        conv._set_projection("message_count", 1, object())


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_data_path_is_property_derived(monkeypatch, tmp_path):
    """data_path is a derived @property, not a stored field."""
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )
    conv = Conversation.model_validate({"id": "ddd12345-1234-1234-1234-123456789012"})
    assert conv.data_path.endswith("conversation/ddd12345-1234-1234-1234-123456789012/conversation.jsonl")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_data_path_cannot_be_assigned():
    conv = Conversation.model_validate({"id": "ee012345-1234-1234-1234-123456789012"})
    with pytest.raises(AttributeError):
        conv.data_path = "/anywhere"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_add_shared_context_does_not_trip_projection_guard():
    """Merging shared context onto a conversation (the existing-conv share path)
    writes only the shared-context fields — it must not trip the message_ids /
    message_count projection guard, and must be idempotent."""
    from flow_sdk.db.drivers.db_base_record import TypeId

    conv = Conversation.model_validate({"id": "abc12345-1234-1234-1234-123456789012"})
    # Seed projections via the sanctioned writer; assert they survive the merge.
    conv._set_projection("message_count", 2, _PROJECTION_SENTINEL)
    conv._set_projection("message_ids", '[{"typeid":"flow_message-x","ts":"t"}]', _PROJECTION_SENTINEL)

    doc = "markdown-dddd1111-2222-3333-4444-555555555554"
    changed = conv.add_shared_context_entities(TypeId(doc))
    assert changed is True
    assert doc in {str(t) for t in (conv.shared_context_entities or [])}

    # Projection fields untouched by the shared-context write.
    assert conv.message_count == 2
    assert conv.message_ids == '[{"typeid":"flow_message-x","ts":"t"}]'

    # Re-adding the same item is a no-op (dedup by (type, id)).
    assert conv.add_shared_context_entities(TypeId(doc)) is False
