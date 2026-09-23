"""A deployment's threads and timeline: who it talks to, what reached it, what it ran, what it answered.

Read from the rows the deployment already writes; nothing here is stored:

* **messages** — every conversation on a channel the deployment answers, and every conversation one
  of its processes works in. A message the agent wrote is ``reply_sent``; any other is
  ``message_in`` — or ``refused`` when no process works in its conversation because the channel's
  own gate turns its sender away (the same ``admits`` the loop asks).
* **turns** — each process's turn records (``agent_serve``): ``turn_started`` when one began, and
  ``turn_failed`` for a process that failed.

A **thread** is one conversation — a chat, a mail thread, a whole phone call — with its status now:
``live`` while a call is on the line (``agent_calls.active_calls``), ``working`` while a turn runs in
it (``is_turn_busy`` on its process), ``ended`` for a call that is over, else ``idle``.

Every event names its conversation and process, so a client lists the threads (:func:`threads`) and
shows one thread's events (:func:`timeline` with ``conversation``). The deployment's process says the
timeline moved with a ``deployment.timeline`` tag (:func:`announce`); a client reads again.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

from flow_sdk.schema.data_spec.deployment_timeline_spec import (
    DeploymentThread,
    DeploymentThreads,
    DeploymentTimeline,
    TimelineEvent,
)

#: How many of each kind of row one read takes — the newest; older ones are the next page's.
PROCESSES_READ = 100
CONVERSATIONS_READ = 50
#: Messages read per conversation for the thread list (a thread's own page reads its whole history).
MESSAGES_PER_THREAD = 200


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


@dataclass
class _Scan:
    """What one read of the deployment's rows found."""

    agent_name: str = ""
    events: list[TimelineEvent] = field(default_factory=list)
    conversations: dict[str, Any] = field(default_factory=dict)
    #: conversation id → its newest process of this deployment.
    processes: dict[str, Any] = field(default_factory=dict)


async def _scan(deployment, *, conversation: Optional[str] = None, per_conversation: int) -> _Scan:
    """Every event on *deployment* — or only in *conversation* — at most *per_conversation* messages each."""
    from flow_sdk.builtin.agent_serve import admits, answers_here, turns_of  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.process_lifecycle import ProcessStatus  # noqa: PLC0415

    scan = _Scan()
    match: dict[str, Any] = {"deployment_id": deployment.id}
    if conversation:
        match["target_typeid_str"] = f"conversation-{conversation}"
    processes = await AgenticProcess.local_rows(
        {"match": match, "order_by": {"updated_date": "desc"}, "limit": PROCESSES_READ}
    )
    for process in processes:  # newest first: a conversation's newest process is its own
        scan.processes.setdefault(_conversation_of(process), process)
    scan.processes.pop("", None)

    agent = await deployment.agent()
    scan.agent_name = str(getattr(agent, "name", "") or "") if agent else ""
    # Every channel this deployment answers — live ones (a call) included, which the drain leaves out.
    sources = {str(s.id): s for s in (await agent.channels() if agent else []) if await answers_here(s, deployment)}

    if conversation:
        row = await Conversation.get_by_id(conversation)
        if row is not None:
            scan.conversations[conversation] = row
    else:
        for source_id in sources:
            for row in await Conversation.get_all(
                {"match": {"channel_source_id": source_id}, "order_by": {"updated_date": "desc"}, "limit": CONVERSATIONS_READ}
            ):
                scan.conversations[str(row.id)] = row
        for conversation_id in scan.processes:
            if conversation_id not in scan.conversations:
                row = await Conversation.get_by_id(conversation_id)
                if row is not None:
                    scan.conversations[conversation_id] = row

    for conversation_id, row in scan.conversations.items():
        process = scan.processes.get(conversation_id)
        process_id = str(process.id) if process is not None else ""
        source_id = str(getattr(row, "channel_source_id", "") or "")
        channel = str(getattr(row, "channel", "") or "")
        for message in await FlowMessage.get_all(
            {"match": {"conversation_id": conversation_id}, "order_by": {"created_date": "desc"}, "limit": per_conversation}
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
            scan.events.append(
                TimelineEvent(
                    at=at,
                    kind=kind,
                    who=(scan.agent_name if mine else "") or str(getattr(message, "sender_name", "") or address),
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
        row = scan.conversations.get(conversation_id)
        channel = str(getattr(row, "channel", "") or "") if row is not None else ""
        source_id = str(getattr(row, "channel_source_id", "") or "") if row is not None else ""
        common = dict(channel=channel, data_source_id=source_id, process_id=str(process.id), conversation_id=conversation_id)
        for record in turns_of(process).values():
            at = _utc(record.get("at")) if isinstance(record, dict) else None
            if at is not None:
                scan.events.append(TimelineEvent(at=at, kind="turn_started", who=scan.agent_name, text=str(process.name or ""), **common))
        if str(getattr(process, "status", "")) == ProcessStatus.FAILED.value:
            at = _utc(getattr(process, "updated_date", None))
            if at is not None:
                reason = str(getattr(process, "start_failure", "") or "")
                scan.events.append(TimelineEvent(at=at, kind="turn_failed", who=scan.agent_name, text=reason, **common))
    return scan


async def timeline(
    deployment, *, limit: int = 50, before: Optional[datetime] = None, conversation: Optional[str] = None
) -> DeploymentTimeline:
    """The newest *limit* events on *deployment* — only in *conversation*, when given — older than *before*."""
    scan = await _scan(deployment, conversation=conversation, per_conversation=limit)
    events = [e for e in scan.events if before is None or e.at < before]
    events.sort(key=lambda e: e.at, reverse=True)
    page = events[:limit]
    return DeploymentTimeline(
        deployment_id=str(deployment.id),
        events=page,
        before=page[-1].at if len(events) > limit else None,
    )


def _status(conversation_id: str, channel: str, process, events: list[TimelineEvent], live: set[str]) -> str:
    from flow_sdk.builtin.agent_calls import CALL_ENDED  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.status_predicates import is_turn_busy  # noqa: PLC0415

    if conversation_id in live:
        return "live"
    if process is not None and is_turn_busy(process):
        return "working"
    newest_message = next((e for e in events if e.kind in ("message_in", "reply_sent")), None)
    if channel == "voice" and newest_message is not None and newest_message.text == CALL_ENDED:
        return "ended"
    return "idle"


async def threads(deployment, *, limit: int = 50) -> DeploymentThreads:
    """The conversations *deployment* holds, the most recently active first, each with its status now."""
    from flow_sdk.builtin.agent_calls import active_calls  # noqa: PLC0415

    scan = await _scan(deployment, per_conversation=MESSAGES_PER_THREAD)
    live = {str(c.get("conversation_id") or "") for c in active_calls().values()}
    by_thread: dict[str, list[TimelineEvent]] = {}
    for event in scan.events:
        if event.conversation_id:
            by_thread.setdefault(event.conversation_id, []).append(event)

    out: list[DeploymentThread] = []
    for conversation_id, row in scan.conversations.items():
        events = sorted(by_thread.get(conversation_id, []), key=lambda e: e.at, reverse=True)
        process = scan.processes.get(conversation_id)
        channel = str(getattr(row, "channel", "") or "")
        other = next((e.who for e in reversed(events) if e.kind in ("message_in", "refused") and e.who), "")
        latest = next((e for e in events if e.kind in ("message_in", "reply_sent", "refused")), None)
        out.append(
            DeploymentThread(
                conversation_id=conversation_id,
                title=str(getattr(row, "title", "") or "") or other,
                who=other,
                channel=channel,
                data_source_id=str(getattr(row, "channel_source_id", "") or ""),
                process_id=str(process.id) if process is not None else "",
                status=_status(conversation_id, channel, process, events, live),
                started_at=events[-1].at if events else _utc(getattr(row, "created_date", None)),
                last_at=events[0].at if events else _utc(getattr(row, "updated_date", None)),
                last_text=latest.text if latest is not None else "",
                messages=sum(1 for e in events if e.kind in ("message_in", "reply_sent", "refused")),
                turns=sum(1 for e in events if e.kind == "turn_started"),
            )
        )
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    # Active ones first — what is happening now — then by recency.
    out.sort(key=lambda t: (t.status in ("live", "working"), t.last_at or epoch), reverse=True)
    return DeploymentThreads(deployment_id=str(deployment.id), threads=out[:limit])


__all__ = ["TAG", "announce", "threads", "timeline"]
