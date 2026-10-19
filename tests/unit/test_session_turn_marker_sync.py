"""The session-turn marker must survive a hub refresh.

When the host consumes a prompt as a session turn it sets the local-only
``prompt_auto_handled`` marker; the hub never learns of it. A plain hub→local
refresh (``merge_hub_payload``) must not revert it — that would re-run the
turn on every sync. Attachments carry NO approval stamps any more: consent is
a property of the session, and the hub's still-mirrored ``proposer_id`` /
``approved_by`` arrive as nulls that are ignored.
"""
import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROMPT_REF = "prompt-11111111-1111-4111-8111-111111111111"


def _local_consumed() -> FlowMessage:
    return FlowMessage.model_validate({
        "id": "fm-1",
        "text": "Please run the following prompt:",
        "prompt_auto_handled": True,
        "attachment": [{"attachment_type": AttachmentType.TYPE_ID.value, "data": PROMPT_REF}],
    })


def _hub_payload() -> dict:
    return {
        "text": "Please run the following prompt:",
        "prompt_auto_handled": False,
        "attachment": [
            {"attachment_type": AttachmentType.TYPE_ID.value, "data": PROMPT_REF,
             "proposer_id": None, "approved_by": None},
        ],
    }


def test_prompt_auto_handled_is_local_only():
    assert "prompt_auto_handled" in FlowMessage.fields_not_accepted_from_hub()


def test_merge_preserves_local_marker():
    merged = FlowMessage.merge_hub_payload(_local_consumed(), _hub_payload())
    assert merged["prompt_auto_handled"] is True


def test_attachment_has_no_approval_stamps():
    att = Attachment.model_validate(
        {"attachment_type": AttachmentType.TYPE_ID.value, "data": PROMPT_REF,
         "proposer_id": "x", "approved_by": "y"}
    )
    assert not hasattr(att, "approved_by") and not hasattr(att, "proposer_id")
    assert "approved_by" not in att.model_dump()


def test_clone_for_forward_does_not_carry_auto_handled():
    src = _local_consumed()
    src.conversation_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    clone = src.clone_for_forward(
        conversation_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sender_id="me", sender_name="Me",
    )
    assert clone.prompt_auto_handled is False
