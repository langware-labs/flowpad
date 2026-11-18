"""A session waits for the reply to a message it sent (``flow conversation send … --on-reply``).

The rule is an ordinary TAG trigger with one ``prompt_process`` action — the same callback
``flow process schedule`` makes, woken by a message instead of a clock:

- it listens on ``entity.child_created`` for the message's conversation, which every write path
  emits (a reply typed here, a hub message live or caught up, a channel projection);
- the first message there after the question, written by a person and not by a session or an
  agent, is the reply — quoted or not. The rule fires once (``fire_once``);
- at ``expires_at`` an unanswered rule is cancelled: a message in its Automations conversation
  says so, and it never fires (docs/automations.md "A callback into a session").
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from flow_sdk.automations.lifecycle import on_end
from flow_sdk.utils.serialization import iso_to_utc

logger = logging.getLogger(__name__)

#: How long a session waits for a reply unless it asks for another wait.
REPLY_WAIT = timedelta(days=3)
REPLY_TAG = "entity.child_created"


def _quote(message: Any, n: int) -> str:
    """A message's text, one line, cut at ``n`` and quoted — "your message" when it has none."""
    text = " ".join(str(getattr(message, "text", "") or "").split())
    return f"“{text[:n]}{'…' if len(text) > n else ''}”" if text else "your message"


def _message_id(typeid: Optional[str]) -> str:
    return str(typeid or "").removeprefix("flow_message-")


async def create(process_id: str, conversation_id: str, message_id: str, prompt: str,
                 wait: Optional[timedelta] = None) -> Any:
    """The waiting rule for ``message_id``: saved, linked to the session and armed. Raises
    ``ValueError`` with the words a caller shows when it cannot be made."""
    from flow_sdk.builtin.trigger import Trigger  # noqa: PLC0415
    from flow_sdk.builtin.trigger_arming import arm_trigger  # noqa: PLC0415
    from flow_sdk.schema.data_spec.trigger_types import TriggerType  # noqa: PLC0415

    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("--on-reply needs the prompt the session runs when the reply comes.")
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    until = datetime.now(timezone.utc) + (wait or REPLY_WAIT)
    asked = await FlowMessage.get_by_id(message_id)
    rule = Trigger(
        name=f"Reply to {_quote(asked, 50)}",
        trigger_type=TriggerType.TAG,
        tag_pattern=REPLY_TAG,
        tag_target=f"conversation:{conversation_id}",
        max_runs=1,
        awaits_reply=f"flow_message-{message_id}",
        expires_at=until,
        actions=[{"action_type": "prompt_process", "target_type_id": f"agentic_process-{process_id}",
                  "prompt": prompt}],
        scope="user",
    )
    problem = await rule.bind_callback()
    if problem:
        raise ValueError(problem)
    await rule.save()
    await rule.link_process()
    await arm_trigger(rule, replace=True)
    return rule


async def _session_written(conversation_id: str) -> set[str]:
    """Ids of the messages in a conversation that a session wrote (``flow conversation send`` from a worker
    links each one into its session) — one read of the conversation, its sessions fetched together."""
    import asyncio  # noqa: PLC0415

    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

    conv = await Conversation.get_by_id(conversation_id) if conversation_id else None
    sessions = [str(t) for t in getattr(conv, "shared_context_entities", None) or [] if str(t).startswith("agentic_process-")]
    procs = await asyncio.gather(*(AgenticProcess.get_by_typeid(t) for t in sessions))
    return {str(t).removeprefix("flow_message-") for p in procs if p is not None
            for t in p.shared_context_entities or [] if str(t).startswith("flow_message-")}


def _answers(asked: Any, fm: Any, written: set[str]) -> bool:
    """``fm`` answers ``asked``: same conversation, not it, not before it, by a person (no agent, no session)."""
    from flow_sdk.schema.data_spec.message_sender_spec import SenderKind  # noqa: PLC0415

    if fm is None or str(fm.id) == str(asked.id) or fm.conversation_id != asked.conversation_id:
        return False
    when, asked_at = iso_to_utc(fm.occurred_at), iso_to_utc(asked.occurred_at)
    if when is not None and asked_at is not None and when < asked_at:
        return False
    sender = getattr(fm, "sender", None)
    return not (sender is not None and sender.kind is SenderKind.AGENT) and str(fm.id) not in written


async def is_reply(rule: Any, message_id: str) -> bool:
    """``message_id`` answers the message ``rule`` waits on."""
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    if not message_id or message_id == _message_id(rule.awaits_reply):
        return False
    fm = await FlowMessage.get_by_id(message_id)
    if fm is None or (getattr(fm, "sender", None) and str(fm.sender.kind) == "agent"):
        return False
    asked = await FlowMessage.get_by_id(_message_id(rule.awaits_reply))
    return asked is not None and _answers(asked, fm, await _session_written(fm.conversation_id))


def reply_of(event: Any) -> str:
    """The new message an ``entity.child_created`` event names (its scope's ``flow_message:<id>``)."""
    for entry in getattr(getattr(event, "ctx", None), "scope", None) or []:
        if str(entry).startswith("flow_message:"):
            return str(entry).split(":", 1)[1]
    return ""


async def reply_text(rule: Any, event: Any) -> str:
    """What the woken session reads after the callback line: who answered, what, how to answer back."""
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.schema.data_spec.message_form_spec import answers_in  # noqa: PLC0415

    fm = await FlowMessage.get_by_id(reply_of(event)) if event is not None else None
    if fm is None:
        return ""
    who = getattr(fm, "author_label", "") or "Someone"
    text = " ".join(str(fm.text or "").split())
    answers = answers_in(fm.attachment)
    parts = [f'{who} replied in conversation {fm.conversation_id} to your message {_message_id(rule.awaits_reply)}:']
    if text:
        parts.append(f'"{text}"')
    if answers is not None:
        import json  # noqa: PLC0415

        parts.append(f"Form answers: {json.dumps(answers.values, ensure_ascii=False)}")
    parts.append(f'Answer with: flow conversation send {fm.conversation_id} "<text>" --reply-to {fm.id}')
    return " ".join(parts)


async def reconcile(rule: Any) -> None:
    """On arming: a reply that landed while nothing listened (the app closed, before the rule existed)
    fires now, once. Its end time is the generic one (automations/lifecycle.py)."""
    from flow_sdk.automations.lifecycle import status  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    if status(rule) != "active":
        return
    asked = await FlowMessage.get_by_id(_message_id(rule.awaits_reply))
    if asked is None:
        return
    rows = await FlowMessage.get_all({"conversation_id": asked.conversation_id}) or []
    written = await _session_written(asked.conversation_id)
    replies = [fm for fm in rows if _answers(asked, fm, written)]
    if replies:
        fm = min(replies, key=lambda m: iso_to_utc(m.occurred_at) or iso_to_utc(asked.occurred_at))
        from flow_sdk.builtin.tag_triggers import _fire_tag_trigger  # noqa: PLC0415
        from flow_sdk.tags.bus import event_bus  # noqa: PLC0415

        event = event_bus.make_event(REPLY_TAG, f"conversation:{asked.conversation_id}",
                                     {"entity_type": "conversation", "id": asked.conversation_id},
                                     ctx={"scope": [f"flow_message:{fm.id}"]})
        await _fire_tag_trigger(str(rule.id), event)


@on_end
async def post_not_answered(rule: Any, reason: str) -> None:
    """A reply wait that ended with no reply (its time passed, or it was cancelled) says so in its
    Automations conversation. The generic end calls it for every rule (automations/lifecycle.on_end)."""
    if not getattr(rule, "awaits_reply", None) or reason == "max_runs":
        return
    from flow_sdk.app.automation_message import automation_conversation, post_message  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage, FlowMessageKind  # noqa: PLC0415
    from flow_sdk.schema.data_spec.automation_spec import AutomationRef  # noqa: PLC0415
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    asked = await FlowMessage.get_by_id(_message_id(rule.awaits_reply))
    head = _quote(asked, 80)
    process = await rule.target_process()
    session = getattr(process, "name", None) or "the session"
    someone = (await get_or_create_local_user()).typeid
    conv = await automation_conversation(AutomationRef(trigger_id=str(rule.id), name=rule.name), someone)
    await post_message(
        conv.id,
        f"Prompt handling cancelled: nobody replied to {head} in time. {session} was not woken.",
        kind=FlowMessageKind.AUTOMATION_RESULT,
        sender_name=rule.name or "Automation",
        someone=someone,
    )
