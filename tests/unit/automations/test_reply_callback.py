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
    note = await Conversation.get_one({"channel": "automations", "channel_source_id": f"trigger-{rule.id}"})
    texts = [m.text for m in await FlowMessage.get_all({"conversation_id": note.id})]
    assert any(t.startswith("Prompt handling cancelled") for t in texts)
    await _arrive(spent, await _message(conv.id, "late answer"))
    assert _queued(process) == []


@async_context
async def test_a_wait_past_its_time_never_fires():
    process, conv, _, rule = await _setup()
    rule.expires_at = rule.expires_at - timedelta(days=4)
    await rule.update()

    await _arrive(rule, await _message(conv.id, "Team"))

    assert _queued(process) == []
