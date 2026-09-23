"""A deployment's timeline: what reached it, what it ran, what it answered — newest first.

Read from the rows the deployment already writes; nothing here is stored:

* **messages** — every conversation on a channel the deployment answers, and every conversation one
  of its processes works in. A message the agent wrote is ``reply_sent``; any other is
  ``message_in`` — or ``refused`` when no process works in its conversation because the channel's
  own gate turns its sender away (the same ``admits`` the loop asks).
* **turns** — each process's turn records (``agent_serve``): ``turn_started`` when one began, and
  ``turn_failed`` for a process that failed.

Every event names the process it belongs to (when one does), so selecting it opens that process.
The deployment's process says the timeline moved with a ``deployment.timeline`` tag
(:func:`announce`); a client reads the page again.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from flow_sdk.schema.data_spec.deployment_timeline_spec import DeploymentTimeline, TimelineEvent

#: How many of each kind of row one page reads — the newest; older ones are the next page's.
PROCESSES_READ = 100
CONVERSATIONS_READ = 50


TAG = "deployment.timeline"


def announce(deployment_id: str, kind: str, **data) -> None:
    """Say a deployment's timeline moved (``kind`` says how). Best-effort, like every tag."""
    from flow_sdk.tags.bus import event_bus  # noqa: PLC0415

    event_bus.emit(TAG, f"deployment:{deployment_id}", {"deployment_id": deployment_id, "kind": kind, **data})


def _utc(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _conversation_of(process) -> str:
    target = str(getattr(process, "target_typeid_str", "") or "")
    return target.split("-", 1)[1] if target.startswith("conversation-") else ""


async def timeline(deployment, *, limit: int = 50, before: Optional[datetime] = None) -> DeploymentTimeline:
    """The newest *limit* events on *deployment* (older than *before*, when given)."""
    from flow_sdk.builtin.agent_serve import admits, answers_here, turns_of  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415

    events: list[TimelineEvent] = []
    processes = await AgenticProcess.local_rows(
        {"match": {"deployment_id": deployment.id}, "order_by": {"updated_date": "desc"}, "limit": PROCESSES_READ}
    )
    by_conversation: dict[str, object] = {}
    for process in processes:  # newest first: a conversation's newest process is its own
        by_conversation.setdefault(_conversation_of(process), process)
    by_conversation.pop("", None)

    agent = await deployment.agent()
    # Every channel this deployment answers — live ones (a call) included, which the drain leaves out.
    sources = {str(s.id): s for s in (await agent.channels() if agent else []) if await answers_here(s, deployment)}

    conversations: dict[str, object] = {}
    for source_id in sources:
        for row in await Conversation.get_all(
            {"match": {"channel_source_id": source_id}, "order_by": {"updated_date": "desc"}, "limit": CONVERSATIONS_READ}
        ):
            conversations[str(row.id)] = row
    for conversation_id in by_conversation:
        if conversation_id not in conversations:
            row = await Conversation.get_by_id(conversation_id)
            if row is not None:
                conversations[conversation_id] = row

    agent_name = str(getattr(agent, "name", "") or "") if agent else ""
    for conversation_id, conversation in conversations.items():
        process = by_conversation.get(conversation_id)
        process_id = str(process.id) if process is not None else ""
        source_id = str(getattr(conversation, "channel_source_id", "") or "")
        channel = str(getattr(conversation, "channel", "") or "")
        for message in await FlowMessage.get_all(
            {"match": {"conversation_id": conversation_id}, "order_by": {"created_date": "desc"}, "limit": limit}
        ):
            at = _utc(getattr(message, "sent_at", None) or getattr(message, "created_date", None))
            if at is None:
                continue
            sender = getattr(message, "sender", None)
            mine = str(getattr(sender, "kind", "") or "") == "agent"
            address = str(getattr(sender, "address", "") or "")
            kind = "reply_sent" if mine else "message_in"
            if not mine and process is None:
                # No process works in its conversation: turned away by the channel's gate — or not
                # taken YET (its turn is about to start), which is just a message in.
                source = sources.get(source_id)
                if source is not None and not admits(source, address):
                    kind = "refused"
            events.append(
                TimelineEvent(
                    at=at,
                    kind=kind,
                    who=(agent_name if mine else "") or str(getattr(message, "sender_name", "") or address),
                    text=str(getattr(message, "text", "") or "")[:280],
                    channel=channel,
                    data_source_id=source_id,
                    process_id=process_id,
                    conversation_id=conversation_id,
                    message_id=str(message.id),
                )
            )

    for process in processes:
        conversation_id = _conversation_of(process)
        conversation = conversations.get(conversation_id)
        channel = str(getattr(conversation, "channel", "") or "") if conversation is not None else ""
        source_id = str(getattr(conversation, "channel_source_id", "") or "") if conversation is not None else ""
        common = dict(channel=channel, data_source_id=source_id, process_id=str(process.id), conversation_id=conversation_id)
        for record in turns_of(process).values():
            at = _utc(record.get("at")) if isinstance(record, dict) else None
            if at is not None:
                events.append(TimelineEvent(at=at, kind="turn_started", who=agent_name, text=str(process.name or ""), **common))
        if str(getattr(process, "status", "")) == ProcessStatus.FAILED.value:
            at = _utc(getattr(process, "updated_date", None))
            if at is not None:
                reason = str(getattr(process, "start_failure", "") or "")
                events.append(TimelineEvent(at=at, kind="turn_failed", who=agent_name, text=reason, **common))

    if before is not None:
        events = [e for e in events if e.at < before]
    events.sort(key=lambda e: e.at, reverse=True)
    page = events[:limit]
    return DeploymentTimeline(
        deployment_id=str(deployment.id),
        events=page,
        before=page[-1].at if len(events) > limit else None,
    )


__all__ = ["DeploymentTimeline", "TAG", "TimelineEvent", "announce", "timeline"]
