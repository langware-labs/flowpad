"""What the stream inbox announces, and the grammar it announces it in.

Follows the ``<family>_on_tag.py`` convention (see ``flow_sdk/ingest/ingest_on_tag.py``
and ``flow_sdk/db/entity_on_tag.py``): the family's tag strings are declared in
one file rather than invented at whichever call site needed one first.

One tag lives here today::

    stream_inbox.<provider>.message.projected
      target: source_item:<id>
      scope:  data_source:<id>
      data:   {entity_id, source_id}

It says a message is now PLACED IN A CONVERSATION — which is a different fact
from ``ingest.*.item.created``, and the one a consumer needs, because a thread's
``conversation_id`` does not exist until the projection has committed. A
consumer keyed on the ingest tag is racing that write: Law 3 detaches every
handler, so it reads no thread and drops the message with a warning nobody sees.
"""

from __future__ import annotations

import asyncio


def emit_projected_tag(item) -> None:
    """Announce one message's placement in a conversation.

    Carries identity and a pointer, never the body — same contract as the ingest
    lane, so a subscriber recovers the row itself and survives a restart.

    The ``scope`` matters as much as the tag: scoped subscriptions and the Events
    screen both filter on it, so an announcement without one is invisible to
    anything narrowing by data source.
    """
    from flow_sdk.tags import emit_tag  # noqa: PLC0415

    envelope = projected_envelope(item.provider, str(item.id), str(item.data_source_id))
    emit_tag(envelope["tag"], envelope["target"], envelope["data"], ctx={"scope": envelope["scope"]})


def projected_envelope(provider: str, source_item_id: str, source_id: str) -> dict:
    """The projected-message envelope's parts — the ONE spelling, shared by the real announcement and a
    test fire on a message (``automations.run_once.message_event``)."""
    from flow_sdk.tags import target_of  # noqa: PLC0415

    return {
        "tag": f"stream_inbox.{provider or 'unknown'}.message.projected",
        "target": target_of("source_item", source_item_id),
        "data": {"entity_id": source_item_id, "source_id": source_id},
        "scope": [target_of("data_source", source_id)] if source_id else [],
    }


def emit_message_status(source, message_id: str) -> None:
    """An agent on this machine took one of ``source``'s messages (``message_id``, its origin key): it is being
    handled. Live only — nothing is kept; the conversation shows it until the reply lands."""
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    if not message_id:
        return
    emit_tag(
        f"stream_inbox.{source.provider or 'unknown'}.message.status",
        target_of("data_source", source.id),
        {"message_id": message_id, "state": "handling", "source_id": source.id},
        ctx={"scope": [target_of("data_source", source.id)]},
    )


def emit_reply_failed(source, conversation_id: str, reason: str) -> None:
    """A reply sent into ``conversation_id`` through ``source`` did not go: the channel's own words. The send ran
    after its request returned, so this is how the person who pressed Send hears."""
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    source_id = str(getattr(source, "id", "") or "")
    emit_tag(
        f"stream_inbox.{getattr(source, 'provider', '') or 'unknown'}.reply.failed",
        target_of("conversation", conversation_id),
        {"conversation_id": conversation_id, "reason": reason[:500], "source_id": source_id},
        ctx={"scope": [target_of("data_source", source_id)]} if source_id else None,
    )


async def announce_placed_rows(source_item_id: str) -> None:
    """The app's clients learn the rows a placement wrote in ANOTHER process of the instance.

    A local agent deployment drains its channels in its own process (``builtin/agent_loop``) and
    places each message there; its writes go straight to the database, and that process has no
    socket, so the entity ops ``save`` makes reach nobody. Only its ``projected`` tag crosses
    (``tags/relay``) — and a tag alone moves nothing that renders from entities: the stream inbox
    list is a live query, and the open conversation's pointers are a cached entity. So the app,
    on a relayed placement, re-reads the rows it names and sends their ops to its own clients —
    the message (``CREATE``: it was just placed), its conversation and thread (``UPDATE``) —
    through the same socket path an in-app save takes (``handle_entity_op``). Not through
    ``add_entity_op_notification``: that also emits ``entity.*`` on the app's bus, which would say
    the app wrote rows it did not.
    """
    from flow_sdk.api.api_types.messages import DataOpMessage, OperationType  # noqa: PLC0415
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.core.network.resource_tracker import handle_entity_op  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import _thread_of  # noqa: PLC0415

    if not source_item_id:
        return
    message = await FlowMessage.get_one({"source_item_id": source_item_id})
    if message is None:
        return

    async def _conversation_of():
        return await Conversation.get_one({"id": message.conversation_id}) if message.conversation_id else None

    conversation, thread = await asyncio.gather(_conversation_of(), _thread_of(message))
    rows: list[tuple[object, OperationType]] = [(message, OperationType.CREATE)]
    rows += [(row, OperationType.UPDATE) for row in (conversation, thread) if row is not None]
    for row, op in rows:
        await handle_entity_op(DataOpMessage(data=row, op=op, to_entity=row.typeid))
