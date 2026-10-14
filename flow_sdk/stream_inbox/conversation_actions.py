"""Conversation actions: what a channel lets a person do to a WHOLE conversation (approve a pull
request, close a ticket), as its driver declares them (``Acting.actions``).

``act`` resolves a conversation to its channel source and its origin there and asks the driver,
which checks the action and records a message it wrote as ours (``DriverRuntime.act``).
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.sources.values.origin import CloudOrigin


async def conversation_origin(conversation) -> CloudOrigin:
    """The conversation's origin on its channel source: its newest record there, keyed by the thread
    handle (the record's own key when it has none)."""
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415

    source_id = str(conversation.channel_source_id or "")
    thread = await MessageThread.get_one({"conversation_id": str(conversation.id), "data_source_id": source_id})
    rows = (
        await SourceItem.get_all(
            {
                "match": {"data_source_id": source_id, "thread_key": thread.thread_key},
                "order_by": {"occurred_at": "desc"},
                "limit": 1,
            }
        )
        if thread is not None
        else []
    )
    if not rows or rows[0].origin is None:
        raise ValueError("this conversation did not come through a channel on this machine; there is nothing to act on")
    item = rows[0]
    return CloudOrigin(kind=item.origin.kind, namespace=item.origin.namespace, key=item.thread_key or item.origin.key)


async def act(conversation_id: str, action: str, text: str = "") -> Optional[str]:
    """Run the channel's ``action`` on conversation ``conversation_id``; answers the ``SourceItem`` id
    of the message it wrote (recorded as ours), or ``None`` when it wrote none."""
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.stream_inbox.reactions import channel_of_source  # noqa: PLC0415

    if not action:
        raise ValueError("an action is required")
    conversation = await Conversation.get_one({"id": conversation_id})
    if conversation is None:
        raise LookupError(f"no conversation {conversation_id}")
    source, driver = await channel_of_source(
        conversation.channel_source_id, conversation.channel_provider or "", what=f"conversation {conversation_id}"
    )
    return await driver.act(
        source, await conversation_origin(conversation), action, text, ended=conversation.ended_at is not None
    )


__all__ = ["act", "conversation_origin"]
