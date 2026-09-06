"""The requester's own opening line lands locally at ticket start.

The hub fans a message out to everyone but its sender and refuses a guest the
ticket's children listing, so the guest's opening line has no push and no
listing — `_adopt_opening_line` finds it on the class-level list the guest may
read (my id, my exact text, no earlier than the ticket) or takes it from the
hub's answer once the hub ships ``first_message``.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

ME = "user-me-hub-id"
TEXT = "my printer jams on every second page"


def _row(text: str, created: str, sender: str = ME) -> dict:
    return {"id": str(uuid.uuid4()), "sender_id": sender, "text": text, "created_date": created}


@pytest.fixture
def rig(monkeypatch):
    processed: list[dict] = []
    appended: list[str] = []

    async def fake_process(raw: dict):
        processed.append(raw)
        return raw["id"]

    async def fake_append(*, conv, fm_id, someone_typeid):
        appended.append(fm_id)
        return conv

    async def me():
        return ME

    from flow_sdk.app.actions import notification_action

    monkeypatch.setattr(fma, "_process_single_hub_message", fake_process)
    monkeypatch.setattr(fma, "_current_cloud_user_id", me)
    monkeypatch.setattr(notification_action, "_append_message_to_conversation", fake_append)
    return processed, appended


async def _conversation() -> Conversation:
    conv = Conversation(id=str(uuid.uuid4()), title="t")
    await conv.save(notify=False)
    return conv


async def test_the_opening_line_is_found_by_author_text_and_time(rig, monkeypatch):
    processed, appended = rig
    conv = await _conversation()
    older = _row(TEXT, "2026-09-06T09:00:00Z")  # an identical ticket I opened earlier
    theirs = _row(TEXT, "2026-09-06T10:00:01Z", sender="someone-else")
    mine = _row(TEXT, "2026-09-06T10:00:01Z")
    other_text = _row("different words", "2026-09-06T10:00:02Z")

    async def fake_hub_get(*_a, **_k):
        return [theirs, other_text, mine, older]

    monkeypatch.setattr(fma, "hub_get", fake_hub_get)
    await fma._adopt_opening_line(conv.id, {"created_date": "2026-09-06T10:00:00Z"}, TEXT, "user-local")

    assert [p["id"] for p in processed] == [mine["id"]]
    assert processed[0]["conversation_id"] == conv.id, "the row is filed under the ticket"
    assert appended == [mine["id"]], "and pointed at from the conversation"


async def test_the_hubs_own_answer_wins_when_it_carries_the_message(rig, monkeypatch):
    processed, appended = rig
    conv = await _conversation()
    first = _row(TEXT, "2026-09-06T10:00:01Z")

    async def never(*_a, **_k):
        raise AssertionError("the class list is not consulted when the hub answered")

    monkeypatch.setattr(fma, "hub_get", never)
    await fma._adopt_opening_line(conv.id, {"first_message": first}, TEXT, "user-local")
    assert [p["id"] for p in processed] == [first["id"]] and appended == [first["id"]]


async def test_a_ticket_that_already_has_rows_is_left_alone(rig, monkeypatch):
    processed, appended = rig
    conv = await _conversation()
    await FlowMessage(id=str(uuid.uuid4()), conversation_id=conv.id, text="already here").save(notify=False)

    async def never(*_a, **_k):
        raise AssertionError("nothing to look up")

    monkeypatch.setattr(fma, "hub_get", never)
    await fma._adopt_opening_line(conv.id, {}, TEXT, "user-local")
    assert processed == [] and appended == []
