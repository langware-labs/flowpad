"""``@name``: the send carries who was tagged to the hub, and the arrival names the person it tags."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest

from flow_sdk.app.actions.notification_action import _mentions_of, handle_add_message, message_header_kwargs
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.notifications import desktop

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SENDER = f"user-{uuid.uuid4()}"


async def _plain(conv) -> FlowMessage:
    sent = await handle_add_message({"conversation_id": conv.id, "message": "hi"}, SENDER)
    return await FlowMessage.get_one({"id": sent.data["id"]})


@pytest.mark.parametrize(
    "raw, ids",
    [
        (["u-1", " u-2 ", "u-1", "", 7, None], ["u-1", "u-2"]),
        ('["u-1", "u-2"]', ["u-1", "u-2"]),  # a multipart send carries it as JSON text
        ("not json", []),
        (None, []),
        ([f"u-{n}" for n in range(30)], [f"u-{n}" for n in range(20)]),
    ],
)
def test_a_send_names_each_tagged_person_once(raw, ids):
    assert _mentions_of(raw) == ids


@pytest.mark.asyncio
async def test_the_tags_are_on_the_message_and_on_the_wire(monkeypatch):
    conv = await Conversation.model_validate({"id": str(uuid.uuid4()), "remote": False}).save(None)

    sent = await handle_add_message(
        {"conversation_id": conv.id, "message": "@bob check this", "mentions": ["u-bob"]}, SENDER
    )

    assert sent.data["mentions"] == ["u-bob"]
    stored = await FlowMessage.get_one({"id": sent.data["id"]})
    assert stored.mentions == ["u-bob"]
    body = conv.add_message_body(stored.text, **message_header_kwargs(stored))
    assert body["mentions"] == ["u-bob"], "the hub body names who was tagged"
    assert "mentions" not in conv.add_message_body("hi", **message_header_kwargs(await _plain(conv)))


@pytest.mark.asyncio
async def test_a_tagged_message_never_takes_the_text_only_fast_path(monkeypatch):
    """The fast path carries text alone: a tag would reach the hub without its tags."""
    from flow_sdk.app.actions import notification_action

    fast = AsyncMock(return_value=None)
    monkeypatch.setattr(notification_action, "_try_send_reply_via_hub", fast)
    monkeypatch.setattr(notification_action, "is_logged_in", lambda: True)
    conv = await Conversation.model_validate({"id": str(uuid.uuid4()), "remote": True}).save(None)

    await handle_add_message({"conversation_id": conv.id, "message": "plain"}, SENDER)
    plain_tried = fast.await_count
    assert plain_tried == 1, "a plain message is the one that takes the fast path"
    await handle_add_message({"conversation_id": conv.id, "message": "@bob", "mentions": ["u-bob"]}, SENDER)

    assert fast.await_count == plain_tried, "a tagged message goes the full way"


@pytest.mark.asyncio
@pytest.mark.parametrize("mentioned, title", [(True, "Dana mentioned you"), (False, "Dana")])
async def test_the_arrival_says_when_it_tags_you(monkeypatch, mentioned, title):
    raised = AsyncMock()
    monkeypatch.setattr(desktop, "notify_desktop", raised)

    await desktop.notify_message_arrival("c-1", "m-1", sender_name="Dana", text="check this", mentioned=mentioned)

    assert raised.await_args.kwargs["title"] == title
    assert raised.await_args.kwargs["click_target"]["pointer"] == "c-1/message/m-1"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mentions, tags_me",
    [(["u-cloud"], True), (["u-local", "u-other"], True), (["u-other"], False), ([], False), (None, False)],
)
async def test_an_arrival_tags_me_by_any_id_this_computer_goes_by(monkeypatch, mentions, tags_me):
    from flow_sdk.builtin.user import User
    from flow_sdk.cloud_client.hub_bridge import _tags_me

    monkeypatch.setattr(User, "self_ids", AsyncMock(return_value={"u-local", "u-cloud"}))

    assert await _tags_me({"mentions": mentions}) is tags_me
