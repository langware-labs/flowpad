"""Threads in Flowpad's own chat — the native half of ``MessageThread``.

A channel thread comes from the provider (Gmail's thread id, Slack's ``thread_ts``) and the
stream inbox projection resolves it. A native thread has no provider: it is the reply chain
rooted at one message. What travels between members is only ``FlowMessage.thread_root_id`` —
the root's id, which is the hub's and so the same on every machine. Each machine resolves it
to ITS OWN ``MessageThread`` row by the natural key ``("flowpad", <root id>, <local owner>, "")``
(looked up, never derived — the entity-id policy) and stamps ``thread_id`` on the root and
every message in the thread, so the feed's thread machinery (packed ``ThreadStack`` rows,
``?thread=``, counts) reads native threads exactly as it reads a mailbox.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.message_thread import MessageThread

logger = logging.getLogger(__name__)

#: The channel name a native thread is keyed under — Flowpad's own chat (``conversation_channel.FLOWPAD``).
NATIVE_CHANNEL = "flowpad"
#: A native thread is read by no data source: the empty account half of the natural key.
_NO_SOURCE = ""
_TITLE_CHARS = 80
#: A thread born before its root reached this machine is titled this until the root lands.
_UNTITLED = "Thread"


async def thread_root_for_reply(conversation_id: str, reply_to_id: str) -> Optional[str]:
    """The root of the thread a reply to ``reply_to_id`` joins, or None when that message is not
    one of this conversation's. A reply to a message already in a thread joins that thread; a
    reply to anything else opens the thread rooted at it."""
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415

    parent = await FlowMessage.get_one({"id": reply_to_id})
    if parent is None or (parent.conversation_id or "") != conversation_id:
        return None
    return parent.thread_root_id or parent.id


async def _local_owner() -> Optional[str]:
    """The owner half of a native thread's key: the local user, as channel threads key theirs."""
    from flow_sdk.builtin.user import User  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    user = await User.get_local()
    return str(TypeId(type="user", id=user.id)) if user and user.id else None


def _title_of(root: Optional["FlowMessage"]) -> str:
    text = " ".join(((root.text if root else "") or "").split())
    if not text:
        return _UNTITLED
    return text if len(text) <= _TITLE_CHARS else text[: _TITLE_CHARS - 1].rstrip() + "…"


async def project_native_thread(fm: "FlowMessage", *, notify: bool = True) -> Optional["MessageThread"]:
    """Put ``fm`` — and the root it names — into this machine's row for its native thread.

    No-op for a message outside a native thread (``thread_root_id`` unset). Called on both
    ends: the sender after saving a reply, the receiver after materializing one. Idempotent: a
    re-delivered message finds the row, re-stamps nothing that is already right, and the count
    is recomputed from the messages themselves. The root carries no ``thread_root_id`` of its
    own, so it is placed from here, by its replies; one that lands after them joins through
    ``heal_thread_root``.
    """
    root_id = (fm.thread_root_id or "").strip()
    if not root_id or not fm.conversation_id:
        return None
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import recompute_thread_projection, resolve_thread  # noqa: PLC0415

    root = fm if fm.id == root_id else await FlowMessage.get_one({"id": root_id})
    thread = await resolve_thread(
        NATIVE_CHANNEL,
        root_id,
        await _local_owner(),
        data_source_id=_NO_SOURCE,
        title=_title_of(root),
        conversation_id=fm.conversation_id,
    )
    for member in (root, fm):
        if member is not None and member.thread_id != thread.id:
            member.thread_id = thread.id
            await member.save(notify=notify)
    await recompute_thread_projection(thread.id, thread=thread, notify=notify)
    return thread


async def heal_thread_root(fm: "FlowMessage", *, notify: bool = True) -> None:
    """A root that lands AFTER a reply to it (a receiver catching up out of order) joins the
    thread its replies already opened. Cheap no-op for every other message: one indexed lookup
    on the natural key."""
    if fm.thread_root_id or fm.thread_id or not fm.id or not fm.conversation_id:
        return
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import recompute_thread_projection  # noqa: PLC0415

    thread = await MessageThread.find_existing(NATIVE_CHANNEL, fm.id, await _local_owner(), _NO_SOURCE)
    if thread is None:
        return
    fm.thread_id = thread.id
    await fm.save(notify=notify)
    if thread.title == _UNTITLED and _title_of(fm) != _UNTITLED:
        thread.title = thread.name = _title_of(fm)
        await thread.save(notify=notify)
    await recompute_thread_projection(thread.id, thread=thread, notify=notify)


__all__ = ["NATIVE_CHANNEL", "heal_thread_root", "project_native_thread", "thread_root_for_reply"]
