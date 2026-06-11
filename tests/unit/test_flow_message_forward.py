"""``FlowMessage.clone_for_forward`` — the forward-a-message clone contract.

Pure entity-level: the clone must be a NEW message (fresh v4 id, fresh
delivery/read/body state, the forwarder as sender) carrying ``cloned_from_id``
provenance, with content deep-copied and the per-message transport
attachments/context rewritten to the target conversation.
"""
import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.builtin.flow_message import (
    Attachment,
    AttachmentType,
    BodyStatus,
    DeliveryStatus,
    FlowMessage,
)

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SRC_CONV = "11111111-1111-4111-8111-111111111111"
DST_CONV = "22222222-2222-4222-8222-222222222222"
SKILL_REF = "skill-33333333-3333-4333-8333-333333333333"


def _source_message() -> FlowMessage:
    fm = FlowMessage.model_validate({
        "text": "look at this",
        "instruction": "run it",
        "sender_id": "user-original",
        "sender_name": "Original Sender",
        "conversation_id": SRC_CONV,
        "shared_context_entities": [f"conversation-{SRC_CONV}", SKILL_REF],
        "is_read": True,
        "delivery_status": DeliveryStatus.RECEIVED.value,
        "body_status": BodyStatus.READY.value,
    })
    fm.id = FlowMessage.allocate_id(fm.model_dump())
    fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"conversation-{SRC_CONV}"),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=f"flow_message-{fm.id}"),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=SKILL_REF),
        Attachment(attachment_type=AttachmentType.FILE, data="data/report.pdf"),
    ]
    return fm


def _clone(src: FlowMessage) -> FlowMessage:
    return src.clone_for_forward(
        conversation_id=DST_CONV,
        sender_id="user-forwarder",
        sender_name="Forwarder",
    )


def test_clone_gets_fresh_valid_id_and_provenance():
    src = _source_message()
    clone = _clone(src)

    assert clone.id != src.id
    assert is_valid_entity_id(clone.id)
    assert clone.cloned_from_id == src.id
    assert clone.cloned_from_sender_id == "user-original"


def test_clone_rebinds_conversation_and_sender():
    src = _source_message()
    clone = _clone(src)

    assert clone.conversation_id == DST_CONV
    assert clone.sender_id == "user-forwarder"
    assert clone.sender_name == "Forwarder"
    assert clone.text == src.text
    assert clone.instruction == src.instruction


def test_clone_resets_local_lifecycle_state():
    src = _source_message()
    clone = _clone(src)

    assert clone.is_read is False
    assert clone.delivery_status == DeliveryStatus.CREATED.value
    assert clone.body_status == BodyStatus.NA
    assert clone.received_at is None
    assert clone.is_draft is False


def test_clone_rewrites_transport_attachments_and_context():
    src = _source_message()
    clone = _clone(src)

    att_data = [a.data for a in clone.attachment]
    # New transport pair, in front.
    assert att_data[0] == f"conversation-{DST_CONV}"
    assert att_data[1] == f"flow_message-{clone.id}"
    # Old transport refs gone; content refs carried.
    assert f"conversation-{SRC_CONV}" not in att_data
    assert f"flow_message-{src.id}" not in att_data
    assert SKILL_REF in att_data
    assert "data/report.pdf" in att_data

    ctx = [str(c) for c in clone.shared_context_entities]
    assert f"conversation-{DST_CONV}" in ctx
    assert SKILL_REF in ctx
    assert f"conversation-{SRC_CONV}" not in ctx
    assert f"flow_message-{src.id}" not in ctx


def test_clone_attachments_are_deep_copies():
    src = _source_message()
    clone = _clone(src)

    cloned_skill = next(a for a in clone.attachment if a.data == SKILL_REF)
    cloned_skill.prompt_preview = "mutated"
    src_skill = next(a for a in src.attachment if a.data == SKILL_REF)
    assert src_skill.prompt_preview is None


def test_clone_roundtrips_through_model_dump():
    """Provenance must survive serialization — it rides the bundle header
    (pack_bundle model_dumps the FM) and the hub header mirror."""
    src = _source_message()
    clone = _clone(src)

    dump = clone.model_dump(context={"skip_api_serializer": True})
    assert dump["cloned_from_id"] == src.id
    assert dump["cloned_from_sender_id"] == "user-original"

    revived = FlowMessage.model_validate(dump)
    assert revived.cloned_from_id == src.id
    assert revived.conversation_id == DST_CONV
