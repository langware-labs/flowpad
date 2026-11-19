"""A guest message's reference and a steer in a ticket's team conversation arrive on hub metadata.

The hub writes them (``metadata.guest_message`` / ``metadata.steer``) and keeps them current as screening
decides or delivery ends; the desktop derives the kind and the private field on every arrival and applies an
UPDATE's status (and, for a guest message, the text that fills in once it passed).
"""

from __future__ import annotations

import uuid

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.flow_message import FlowMessage, FlowMessageKind, derive_guest_message, derive_steer
from flow_sdk.cloud_client.hub_bridge import HubWsBridge
from flow_sdk.schema.data_spec.guest_message_spec import (
    GuestMessageRef,
    GuestMessageStatus,
    SteerDeliveryStatus,
    SteerRef,
)

pytestmark = [pytest.mark.timeout(30)]  # do not increase timeout without approval


class _NoHub:
    def send(self, *_a, **_kw):
        pass


def test_a_guest_message_reference_gives_the_message_its_kind_and_keeps_its_last_status():
    fm = FlowMessage.model_validate({"text": ""})
    derive_guest_message(fm, {"metadata": {"guest_message": {"id": "gm-1", "status": "pending"}}})
    assert fm.kind is FlowMessageKind.GUEST_MESSAGE and fm.guest_message == GuestMessageRef(id="gm-1")
    derive_guest_message(fm, {"text": "no metadata"})
    assert fm.guest_message.status is GuestMessageStatus.PENDING
    derive_guest_message(fm, {"metadata": {"guest_message": {"id": "gm-1", "status": "held", "screened_by": "x"}}})
    assert fm.guest_message.status is GuestMessageStatus.HELD, "projected field by field: a key we do not model drops"
    other = FlowMessage.model_validate({"text": "hi"})
    derive_guest_message(other, {"metadata": {"guest_message": {"status": "passed"}}})  # no id: not a reference
    assert other.guest_message is None and other.kind is FlowMessageKind.USER


def test_a_steer_gives_the_message_its_kind():
    fm = FlowMessage.model_validate({"text": "Ask for the invoice month."})
    derive_steer(fm, {"metadata": {"steer": {"agent": "a-1", "ticket": "t-1", "status": "sending"}}})
    assert fm.kind is FlowMessageKind.STEER and fm.steer == SteerRef(agent="a-1", ticket="t-1")


def test_no_client_may_send_the_hub_owned_kinds():
    assert FlowMessageKind.sendable(FlowMessageKind.GUEST_MESSAGE.value) is None
    assert FlowMessageKind.sendable(FlowMessageKind.STEER.value) is None


def test_the_references_are_closed_shapes():
    assert GuestMessageRef(id="gm-1", status="held", reasons=["prompt injection"]).status is GuestMessageStatus.HELD
    assert SteerRef(agent="a-1", ticket="t-1", status="capped").status is SteerDeliveryStatus.CAPPED
    with pytest.raises(ValidationError):
        GuestMessageRef(id="gm-1", status="released")  # a person's release makes it `passed`, never a new status
    with pytest.raises(ValidationError):
        SteerRef(agent="a-1", ticket="t-1", status="text-came-back")


@pytest.mark.asyncio
async def test_the_update_that_passes_a_guest_message_fills_in_its_text():
    fm = FlowMessage.model_validate(
        {
            "conversation_id": str(uuid.uuid4()),
            "text": "",
            "sender_id": "hub",
            "remote": True,
            "guest_message": {"id": "gm-1", "status": "pending"},
        }
    )
    fm.id = str(uuid.uuid4())
    await fm.save(None, notify=False)

    await HubWsBridge(_NoHub())._handle_flow_message_op(
        "update",
        fm.id,
        {"text": "Where is my invoice?", "metadata": {"guest_message": {"id": "gm-1", "status": "passed"}}},
        fm.conversation_id,
    )

    stored = await FlowMessage.get_one({"id": fm.id})
    assert stored.guest_message.status is GuestMessageStatus.PASSED and stored.text == "Where is my invoice?"


def test_a_passed_reference_names_its_files():
    from flow_sdk.schema.data_spec.guest_message_spec import GuestMessageRef

    ref = GuestMessageRef.model_validate(
        {"id": "gm-1", "status": "passed", "files": [{"name": "log.txt", "media_type": "text/plain", "size": 3}]}
    )
    assert [f.name for f in ref.files] == ["log.txt"]
