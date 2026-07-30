"""Receiver prompt-approval state must survive a hub refresh.

When a receiver auto-runs (or approves) a prompt, two pieces of local state are
set that the hub never learns of: the local-only ``prompt_auto_handled`` marker
(auto-run idempotency) and the attachment's ``approved_by``. A plain hub→local
refresh (``merge_hub_payload``) would revert both — re-running the prompt on
every sync and flipping the UI's Execute CTA back on. These tests lock the
preservation.
"""
import pytest

from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PROMPT_REF = "prompt-11111111-1111-4111-8111-111111111111"


def _local_handled() -> FlowMessage:
    """A locally auto-handled message: marker set + attachment approved."""
    return FlowMessage.model_validate({
        "id": "fm-1",
        "text": "Please run the following prompt:",
        "prompt_auto_handled": True,
        "attachment": [
            {"attachment_type": AttachmentType.TYPE_ID.value, "data": PROMPT_REF, "approved_by": "bob-id"},
        ],
    })


def _hub_payload() -> dict:
    """The hub's copy — never carries the receiver's local approval/handling."""
    return {
        "text": "Please run the following prompt:",
        "prompt_auto_handled": False,
        "attachment": [
            {"attachment_type": AttachmentType.TYPE_ID.value, "data": PROMPT_REF, "approved_by": None},
        ],
    }


def test_prompt_auto_handled_is_local_only():
    assert "prompt_auto_handled" in FlowMessage.fields_not_accepted_from_hub()


def test_merge_preserves_local_marker():
    merged = FlowMessage.merge_hub_payload(_local_handled(), _hub_payload())
    # The hub said False; the local True must win (local-only field).
    assert merged["prompt_auto_handled"] is True


def test_merge_preserves_attachment_approved_by():
    merged = FlowMessage.merge_hub_payload(_local_handled(), _hub_payload())
    att = merged["attachment"][0]
    assert att["approved_by"] == "bob-id"  # local approval re-applied over the hub's None


def test_merge_does_not_invent_approval_when_unapproved_locally():
    local = FlowMessage.model_validate({
        "id": "fm-2",
        "text": "x",
        "attachment": [
            {"attachment_type": AttachmentType.TYPE_ID.value, "data": PROMPT_REF, "approved_by": None},
        ],
    })
    merged = FlowMessage.merge_hub_payload(local, _hub_payload())
    assert merged["attachment"][0].get("approved_by") is None


def test_merge_keeps_a_hub_set_approval():
    # If the hub copy already carries an approval, it is not clobbered.
    local = _local_handled()
    hub = _hub_payload()
    hub["attachment"][0]["approved_by"] = "someone-else"
    merged = FlowMessage.merge_hub_payload(local, hub)
    assert merged["attachment"][0]["approved_by"] == "someone-else"


def test_clone_for_forward_does_not_carry_auto_handled():
    """A forwarded clone is a fresh message — it must not inherit the source's
    auto-run marker (model default False)."""
    src = _local_handled()
    src.conversation_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    clone = src.clone_for_forward(
        conversation_id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        sender_id="me", sender_name="Me",
    )
    assert clone.prompt_auto_handled is False
