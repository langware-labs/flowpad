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
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    emit_tag(
        f"stream_inbox.{item.provider or 'unknown'}.message.projected",
        target_of("source_item", item.id),
        {"entity_id": item.id, "source_id": item.data_source_id},
        ctx={"scope": [target_of("data_source", item.data_source_id)]},
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
