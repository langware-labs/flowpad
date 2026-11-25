"""A session waits for the reply to its message (`--on-reply`): the first message a person writes after it
wakes the session once, with the reply; the session's own messages do not; a reply that came while
nothing listened fires when the rule is armed; an unanswered wait is cancelled with a message."""

from __future__ import annotations

from datetime import timedelta

import pytest

from flow_sdk.app.actions.notification_action import link_origin_session
from flow_sdk.automations.lifecycle import end
from flow_sdk.builtin import reply_callbacks
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.tag_triggers import _fire_tag_trigger
from flow_sdk.builtin.trigger import Trigger, pending_callbacks
from flow_sdk.builtin.trigger_arming import arm_trigger
from flow_sdk.tags.bus import event_bus
from tests.pytest_plugin import async_context

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


async def _setup():
    process = AgenticProcess(name="pricing", pty_mode=False, visible=False)
    await process.save()
    process.queue.set_enabled(False)  # keep deliveries, run nothing
    conv = await Conversation(title="Landing page pricing").save(None)
    asked = await _message(conv.id, "Which plan should we lead with?")
    await link_origin_session(conv.id, asked.id, process.id, None)  # the session sent it
    rule = await reply_callbacks.create(process.id, conv.id, asked.id, "pick the hero plan")
    return process, conv, asked, rule


async def _message(conversation_id: str, text: str) -> FlowMessage:
    fm = FlowMessage(text=text, conversation_id=conversation_id)
    await fm.save()
    return fm


async def _arrive(rule: Trigger, fm: FlowMessage) -> None:
    event = event_bus.make_event(reply_callbacks.REPLY_TAG, f"conversation:{fm.conversation_id}",
                                 {"entity_type": "conversation", "id": fm.conversation_id},
                                 ctx={"scope": [f"flow_message:{fm.id}"]})
    await _fire_tag_trigger(str(rule.id), event)


def _queued(process: AgenticProcess) -> list[str]:
    return [e["prompt"] for e in process.queue.read()["entries"]]


@async_context
async def test_the_first_reply_wakes_the_session_once_with_the_reply():
    process, conv, _, rule = await _setup()
    assert [t.id for t in await pending_callbacks(await AgenticProcess.get_by_id(process.id))] == [rule.id]

    await _arrive(rule, await _message(conv.id, "Team, most leads are small"))
    await _arrive(rule, await _message(conv.id, "oh and also"))

    queued = _queued(process)
    assert len(queued) == 1
    assert "pick the hero plan" in queued[0] and '"Team, most leads are small"' in queued[0]
    assert "--reply-to" in queued[0]
    assert await pending_callbacks(await AgenticProcess.get_by_id(process.id)) == []


@async_context
async def test_a_live_session_line_is_not_the_reply():
    """2026-11-25: a wait for a session turn's answer was used up by "X approved the live session"."""
    process, conv, _, rule = await _setup()
    line = FlowMessage(text="Shani approved the live session", conversation_id=conv.id, kind="session_event")
    await line.save()

    await _arrive(rule, line)
    assert _queued(process) == []

    await _arrive(rule, await _message(conv.id, "exit 0"))
    assert len(_queued(process)) == 1


@async_context
async def test_a_message_the_session_wrote_is_not_the_reply():
    process, conv, _, rule = await _setup()
    own = await _message(conv.id, "Also: should the trial be free?")
    await link_origin_session(conv.id, own.id, process.id, None)

    await _arrive(rule, own)

    assert _queued(process) == []


@async_context
async def test_a_reply_that_came_while_nothing_listened_fires_when_armed():
    process, conv, _, rule = await _setup()
    await _message(conv.id, "Enterprise")  # landed with no subscription to hear it

    await arm_trigger(await Trigger.get_by_id(rule.id), replace=True)

    assert len(_queued(process)) == 1 and '"Enterprise"' in _queued(process)[0]


@async_context
async def test_an_unanswered_wait_is_cancelled_with_a_message():
    process, conv, _, rule = await _setup()

    await end(rule, "expired")

    spent = await Trigger.get_by_id(rule.id)
    assert spent.ended_reason == "expired" and await pending_callbacks(await AgenticProcess.get_by_id(process.id)) == []
    # the ended rule still says which session made it; the session no longer lists it
    assert process.typeid in spent.shared_context_entities
    assert spent.typeid not in (await AgenticProcess.get_by_id(process.id)).shared_context_entities
    note = await Conversation.get_one({"channel": "automations", "channel_source_id": f"trigger-{rule.id}"})
    [said] = await FlowMessage.sent_in(note.id)
    assert said.card()["status"] == "expired" and said.card()["session"] == str(process.typeid)
    assert said.text == "Nobody replied to “Which plan should we lead with?” within 3 days, so the follow-up was not sent."
    await _arrive(spent, await _message(conv.id, "late answer"))
    assert _queued(process) == []


@async_context
async def test_a_wait_past_its_time_never_fires():
    process, conv, _, rule = await _setup()
    rule.expires_at = rule.expires_at - timedelta(days=4)
    await rule.update()

    await _arrive(rule, await _message(conv.id, "Team"))

    assert _queued(process) == []


@async_context
async def test_the_sessions_own_send_is_not_the_reply():
    """A session sends again into the conversation it waits on: its own send, through the send handler,
    never wakes it — however soon the reply check runs after the save."""
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415

    from ._helpers import settle  # noqa: PLC0415

    process, conv, _, rule = await _setup()
    await arm_trigger(await Trigger.get_by_id(rule.id), replace=True)

    await handle_add_message({"conversation_id": str(conv.id), "message": "Change of plan"}, None,
                             pending_send=True, origin_process=process.id)
    await settle()

    assert _queued(process) == []


@pytest.mark.parametrize("how, status", [("cancelled", "cancelled"), ("reply", "done")])
@async_context
async def test_a_wait_says_how_it_ended(how, status):
    _, conv, _, rule = await _setup()

    if how == "reply":
        await _arrive(rule, await _message(conv.id, "Team, most leads are small"))
    else:
        await end(rule, "cancelled")

    note = await Conversation.get_one({"channel": "automations", "channel_source_id": f"trigger-{rule.id}"})
    [said] = await FlowMessage.sent_in(note.id)
    assert said.card()["status"] == status and said.text == said.card()["summary"]
