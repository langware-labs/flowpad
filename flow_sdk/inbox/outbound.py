"""Reply into the cloud thread a conversation caches.

The inverse of ``flow_sdk/inbox/projection.py`` and deliberately much smaller,
because it does not write anything itself. It resolves *where* to send, hands
the driver the message, and lets the reply come back in through the ordinary
ingest route — the worker records the sent copy with ``flow record create``,
the projector turns it into a FlowMessage, and it sorts into the conversation by
its own timestamp. There is no outbound write path to keep in step with the
inbound one.

**Dispatch is fire-and-forget by design.** An agent turn is tens of seconds; a
conversation must stay usable while one runs. What the caller gets back is "this
was accepted", never "this was delivered" — the second only becomes true when
the message appears.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: How far back to look for the message that names the channel. Every message
#: in a source-backed conversation shares one, so the newest few always answer
#: — and an unbounded load would deserialize a whole mailbox thread to read one
#: field. The same "put the gate in the query" rule the projector follows.
RECENT_WINDOW = 25

#: Strong references to running sends. A bare `create_task` can be collected
#: mid-flight, which would silently drop a send the user believes was accepted.
#: Same idiom as `_RECEPTION_SETUP_TASKS` / `_PENDING_RUNS` elsewhere.
_INFLIGHT: "set[asyncio.Task]" = set()


class ChannelSendUnavailable(Exception):
    """This conversation cannot be replied to through a channel."""


@dataclass(frozen=True)
class ReplyTarget:
    """Where a reply goes, and what carries it."""

    driver: Any
    source: Any
    channel: str
    to: str
    thread_key: str
    subject: str
    #: The provider's id for the message being replied to. Some transports
    #: thread on this rather than on `thread_key`.
    in_reply_to: str


def _authored_here(message, local_id: str) -> bool:
    """Did something on THIS machine write that message?

    We have two outbound identities, not one. ``_sender_for`` stamps a message
    we authored with the local user's id, EXCEPT on an agent's own mailbox,
    where it stamps ``agent:<id>`` so the owner does not appear to have written
    replies they never saw. External senders are always ``<channel>:<address>``.

    Both of ours have to be recognised here, because this predicate chooses who
    the reply is ADDRESSED to (`to` is the target message's sender). Knowing
    only the user id, an agent's own ingested sent copy reads as a stranger and
    the agent mails itself.

    An unknown local user is "we cannot identify ourselves", NOT "everything is
    ours". Folding those together made a missing user row report as "no one else
    has written in this thread yet" — a thread full of strangers described as a
    thread full of us, which points debugging at the wrong half of the system.
    """
    from flow_sdk.inbox.projection import is_agent_sender  # noqa: PLC0415

    sender = str(message.sender_id or "")
    return bool(sender) and (sender == local_id or is_agent_sender(sender))


async def resolve_reply_target(conversation_id: str, *, source_id: str | None = None) -> ReplyTarget:
    """Everything a send needs, or raise saying which part is missing.

    Resolution deliberately reads the SOURCE ITEM for the thread handle rather
    than ``MessageThread.thread_key``: the latter falls back to a normalized
    subject when a provider gives no native handle, and the two are
    indistinguishable once stored. An empty ``SourceItem.thread_key`` is the
    only honest signal that we have no addressable thread.
    """
    # Side-effect import: `drivers/__init__` is what populates the registry, and
    # `get_driver` alone does not pull it in. Without this the resolver races
    # server startup and reports "cannot send" for a driver that can.
    import flow_sdk.ingest.drivers  # noqa: F401,PLC0415
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    from flow_sdk.builtin.user import User  # noqa: PLC0415
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    # Newest-first and bounded: the DB does the ordering, and one page is
    # always enough because every message here shares a channel.
    recent = await FlowMessage.get_all(
        {
            "match": {"conversation_id": conversation_id},
            "order_by": {"created_date": "desc"},
            "limit": RECENT_WINDOW,
        }
    )
    channel_messages = [m for m in recent if m.origin and m.origin.kind]
    if source_id is not None:
        channel_messages = [
            message
            for message in channel_messages
            if message.origin_local and message.origin_local.data_source_id == source_id
        ]
    if not channel_messages:
        raise ChannelSendUnavailable("this conversation did not come from a channel")

    # Reply to the last person who wrote to US, not simply to the last message.
    # Our own sent copies are ingested back into the thread, so the newest
    # message is frequently our own — and addressing that one mails the reply
    # to ourselves. `_sender_for` already resolved this at projection time: a
    # message we authored carries the local user's id, an external one carries
    # `<channel>:<address>`. So this is an exact test, not a heuristic.
    local = await User.get_local()
    local_id = str(getattr(local, "id", "") or "")
    target = next((m for m in channel_messages if not _authored_here(m, local_id)), None)
    if target is None:
        # Every message here is ours — a thread we started and nobody answered.
        # The original recipient is not recorded anywhere, and guessing one is
        # how a reply reaches the wrong person.
        raise ChannelSendUnavailable("no one else has written in this thread yet")

    # Defensive reads end here: these are typed entities.
    origin = target.origin
    # The row pointers live on the PRIVATE half. A message RECEIVED from another
    # machine has none — its `origin` crossed the wire, its `origin_local` did
    # not — which is a different condition from a local record that was deleted,
    # and has to read as one.
    local = target.origin_local
    if local is None:
        raise ChannelSendUnavailable("this message was shared from another machine")

    source, item = await asyncio.gather(
        DataSource.get_one({"id": local.data_source_id}),
        SourceItem.get_one({"id": local.source_item_id}),
    )
    if source is None:
        raise ChannelSendUnavailable("the data source this arrived through is gone")
    if source_id is not None and source.id != source_id:
        raise ChannelSendUnavailable("this conversation does not belong to that Agent inbox")
    if item is None:
        # Distinct from "no sender address" below — collapsing the two made a
        # missing record report as a missing address.
        raise ChannelSendUnavailable("the record this arrived through is gone")

    driver = get_driver(source.provider)
    if driver is None or not driver.sends:
        raise ChannelSendUnavailable(f"the {origin.kind} transport cannot send")

    to = (item.author_external_id or "").strip()
    if not to:
        # Nowhere to send. Better to refuse than to spawn a worker that will
        # guess a recipient.
        raise ChannelSendUnavailable("the message being replied to carries no sender address")

    return ReplyTarget(
        driver=driver,
        source=source,
        channel=origin.kind,
        to=to,
        thread_key=item.thread_key or "",
        subject=item.name or "",
        in_reply_to=item.external_id or "",
    )


async def dispatch_channel_reply(
    conversation_id: str,
    *,
    text: str,
    source_id: str | None = None,
):
    """Accept a reply and start it. Returns once DISPATCHED."""
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

    try:
        target = await resolve_reply_target(conversation_id, source_id=source_id)
    except ChannelSendUnavailable as exc:
        return ApiFailResponse(message=str(exc))

    task = asyncio.create_task(
        _run_send(conversation_id, target, text),
        name=f"channel_send_{conversation_id[:8]}",
    )
    _INFLIGHT.add(task)
    task.add_done_callback(_INFLIGHT.discard)

    return ApiSuccessResponse(data={"accepted": True, "channel": target.channel, "to": target.to})


async def _run_send(conversation_id: str, target: ReplyTarget, text: str) -> None:
    """The background half. Never raises — a failed reply must not take down
    the request that started it, and the worker's own record is the trail."""
    from flow_sdk.builtin.agentic_process.launch_health import LaunchError  # noqa: PLC0415

    try:
        outcome = await target.driver.send(
            target.source,
            thread_key=target.thread_key,
            to=target.to,
            text=text,
            subject=target.subject,
            conversation_id=conversation_id,
            in_reply_to=target.in_reply_to,
        )
        logger.info(
            "[channel-send] %s → %s %s (id=%s, artifact=%s)",
            target.channel,
            target.to,
            outcome.status.value,
            outcome.external_id or "?",
            outcome.artifact_id or "-",
        )
        if not outcome.drafted and not outcome.recorded:
            # Only meaningful for a real send: the mail IS gone, and only the
            # local copy is missing. Re-sending to fix bookkeeping would mail
            # the recipient twice. A DRAFT is never recorded by design, so
            # warning about it would fire on every reply.
            logger.warning("[channel-send] %s → %s delivered but NOT recorded locally", target.channel, target.to)
    except LaunchError as exc:
        logger.error("[channel-send] %s → %s failed: %s", target.channel, target.to, exc.as_dict())
    except Exception:  # noqa: BLE001
        logger.exception("[channel-send] %s → %s failed", target.channel, target.to)
