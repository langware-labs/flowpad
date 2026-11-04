"""``Conversation.share`` of a new conversation: one hub call when the hub takes members.

A hub with ``conversation_create_with_members`` answers the create with ``invitations``; the
conversation, its invitations and its pending first message then go in that one request. A hub
without it drops the extra keys and answers a plain row: the invitations then go the old way.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk._compat import UTC
from flow_sdk.cloud_client.hub_proxy import HubProxy


async def _offline_conversation():
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.fs_store.operations.conversation import append_message_pointer, default_jsonl_path, from_jsonl
    from flow_sdk.fs_store.record_types import RecordType

    conv_id = str(uuid.uuid4())
    conv = Conversation.model_validate({"id": conv_id, "title": "one call"})
    await conv.save()
    msg = FlowMessage(text="hello", conversation_id=conv_id, sender_id="me", outbound=True)
    await msg.save()
    rec = from_jsonl(default_jsonl_path(conv_id), conv_id, conv_id, parent_type=RecordType.PROJECT)
    rec.save()
    append_message_pointer(rec, msg.id, datetime.now(UTC).isoformat())
    return conv, msg


async def _share(conv, answer: dict) -> list[tuple]:
    calls: list[tuple] = []

    async def _call(method, entity_type, entity_id=None, action=None, *, payload=None, **_kw):
        calls.append((method, str(entity_type), action, payload))
        if action is None:
            return {**answer, "initiated_by": "me"}
        return {}

    with (
        patch("flow_sdk.cli.auth.credentials.load_credentials", return_value=MagicMock(api_key="k", user={})),
        patch("flow_sdk.actions.fs.fs_actions.push_entity_files_to_hub", new=AsyncMock()),
        patch.object(HubProxy, "call", new=AsyncMock(side_effect=_call)),
    ):
        await conv.share(recipients=["alice@example.com"])
    return calls


@pytest.mark.asyncio
async def test_a_hub_that_takes_members_gets_one_call():
    from flow_sdk.builtin.flow_message import DeliveryStatus, FlowMessage

    conv, msg = await _offline_conversation()
    calls = await _share(conv, {"invitations": [{"status": "ok"}], "first_message": {"id": "x", "body_status": "NA"}})

    assert len(calls) == 1, calls
    method, _type, action, payload = calls[0]
    assert (method, action) == ("POST", None)
    assert payload["members"][0]["recipient_email"] == "alice@example.com"
    assert payload["members"][0]["invitation_targets"][0]["typeid"] == f"conversation-{conv.id}"
    assert payload["first_message"]["id"] == msg.id and payload["first_message"]["text"] == "hello"
    stored = await FlowMessage.get_one({"id": msg.id})
    assert stored.delivery_status == DeliveryStatus.SENT


@pytest.mark.asyncio
async def test_an_older_hub_gets_the_old_calls():
    conv, msg = await _offline_conversation()
    calls = await _share(conv, {})

    actions = [action for _m, _t, action, _p in calls]
    assert actions[0] is None, "the create, which an older hub answers with the row alone"
    assert "add_message" in actions and actions[-1] == "members"
    assert next(p for _m, _t, a, p in calls if a == "add_message")["id"] == msg.id
