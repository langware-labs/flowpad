"""The outbox: what this machine owes the hub, and ``Conversation.deliver`` handing it over in order.

The hub hop is the one seam replaced here (``_send_conversation_message_header``): the rows, the
pointer index and ``deliver`` are real.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from unittest.mock import patch

import pytest

from flow_sdk._compat import UTC
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import BodyStatus, DeliveryStatus, FlowMessage, FlowMessageKind
from flow_sdk.fs_store.operations.conversation import append_message_pointer, default_jsonl_path, from_jsonl
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.data_spec.hub_failure_spec import HubFailure, HubFailureKind

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.mark.parametrize(
    "fields, owed",
    [
        ({"outbound": True}, True),  # written here, never taken
        ({"delivery_status": "pending_send"}, True),  # the signed-out composer, however it was written
        ({"outbound": True, "delivery_status": "sent"}, False),
        ({"outbound": True, "delivery_status": "sent", "body_status": "uploading"}, True),  # the body is owed
        ({"outbound": True, "delivery_status": "delivered", "body_status": "failed"}, True),
        ({"outbound": False}, False),  # a message someone sent me
        ({"outbound": True, "is_draft": True}, False),
        ({"outbound": True, "kind": FlowMessageKind.INVITATION.value}, False),
    ],
)
async def test_what_this_machine_owes_the_hub(fields, owed):
    assert FlowMessage(text="x", **fields).owes_delivery is owed


async def _conversation_with(*texts: str) -> tuple[Conversation, list[FlowMessage]]:
    conv = Conversation.model_validate({"id": str(uuid.uuid4()), "title": "outbox", "remote": True})
    await conv.save()
    rec = from_jsonl(default_jsonl_path(conv.id), conv.id, conv.id, parent_type=RecordType.PROJECT)
    rec.save()
    messages = []
    for text in texts:
        fm = await FlowMessage(text=text, conversation_id=conv.id, outbound=True).save()
        append_message_pointer(rec, fm.id, datetime.now(UTC).isoformat())
        messages.append(fm)
    return conv, messages


async def test_delivery_goes_in_order_stops_at_the_first_failure_and_resumes():
    conv, (first, second) = await _conversation_with("first", "second")
    sent: list[str] = []
    hub_down = HubFailure(kind=HubFailureKind.OFFLINE, message="Can't reach the hub right now.")

    async def header(_conv, fm):
        if fm.text == "first" and not sent and not header.retried:
            header.retried = True
            return hub_down
        sent.append(fm.text)
        return None

    header.retried = False
    with patch("flow_sdk.app.actions.notification_action._send_conversation_message_header", header):
        await conv.deliver()
        held = await FlowMessage.get_one({"id": first.id})
        assert sent == [] and held.delivery_failure == hub_down, "the second must not overtake the first"

        await conv.deliver()

    assert sent == ["first", "second"]
    for fm in (first, second):
        row = await FlowMessage.get_one({"id": fm.id})
        assert row.delivery_status == DeliveryStatus.SENT.value and row.delivery_failure is None


async def test_a_refused_message_waits_for_the_person():
    conv, (only,) = await _conversation_with("refused")
    refused = HubFailure(kind=HubFailureKind.REJECTED, status=400, message="no")
    only.delivery_failure = refused
    await only.save()
    attempts: list[str] = []

    async def header(_conv, fm):
        attempts.append(fm.id)
        return None

    with patch("flow_sdk.app.actions.notification_action._send_conversation_message_header", header):
        await conv.deliver()
        assert attempts == [], "a refusal is not retried unchanged"
        await conv.deliver(force=True)  # the person's Retry

    assert attempts == [only.id]
    assert (await FlowMessage.get_one({"id": only.id})).body_status == BodyStatus.NA
