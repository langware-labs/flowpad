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


async def resolve_reply_target(conversation_id: str) -> ReplyTarget:
    """Everything a send needs, or raise saying which part is missing.

    Resolution deliberately reads the SOURCE ITEM for the thread handle rather
    than ``MessageThread.thread_key``: the latter falls back to a normalized
    subject when a provider gives no native handle, and the two are
    indistinguishable once stored. An empty ``SourceItem.thread_key`` is the
    only honest signal that we have no addressable thread.
    """
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
    # Side-effect import: `drivers/__init__` is what populates the registry, and
    # `get_driver` alone does not pull it in. Without this the resolver races
    # server startup and reports "cannot send" for a driver that can.
    import flow_sdk.ingest.drivers  # noqa: F401,PLC0415
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    # Newest-first and bounded: the DB does the ordering, and one page is
    # always enough because every message here shares a channel.
    recent = await FlowMessage.get_all({
        "match": {"conversation_id": conversation_id},
        "order_by": {"created_date": "desc"},
        "limit": RECENT_WINDOW,
    })
    target = next((m for m in recent if m.origin and m.origin.kind), None)
    if target is None:
        raise ChannelSendUnavailable("this conversation did not come from a channel")

    # Defensive reads end here: these are typed entities.
    origin = target.origin
    source, item = await asyncio.gather(
        DataSource.get_one({"id": origin.data_source_id}),
        SourceItem.get_one({"id": origin.source_item_id}),
    )
    if source is None:
        raise ChannelSendUnavailable("the data source this arrived through is gone")
    if item is None:
        # Distinct from "no sender address" below — collapsing the two made a
        # missing record report as a missing address.
        raise ChannelSendUnavailable("the record this arrived through is gone")

    driver = get_driver(source.provider)
    if driver is None or not getattr(driver, "sends", False):
        raise ChannelSendUnavailable(f"the {origin.kind} transport cannot send")

    to = (item.author_external_id or "").strip()
    if not to:
        # Nowhere to send. Better to refuse than to spawn a worker that will
        # guess a recipient.
        raise ChannelSendUnavailable("the message being replied to carries no sender address")

    return ReplyTarget(
        driver=driver, source=source, channel=origin.kind, to=to,
        thread_key=item.thread_key or "", subject=item.name or "",
    )


async def dispatch_channel_reply(conversation_id: str, *, text: str):
    """Accept a reply and start it. Returns once DISPATCHED."""
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

    try:
        target = await resolve_reply_target(conversation_id)
    except ChannelSendUnavailable as exc:
        return ApiFailResponse(message=str(exc))

    task = asyncio.create_task(
        _run_send(conversation_id, target, text),
        name=f"channel_send_{conversation_id[:8]}",
    )
    _INFLIGHT.add(task)
    task.add_done_callback(_INFLIGHT.discard)

    return ApiSuccessResponse(data={"accepted": True, "channel": target.channel,
                                    "to": target.to})


async def _run_send(conversation_id: str, target: ReplyTarget, text: str) -> None:
    """The background half. Never raises — a failed reply must not take down
    the request that started it, and the worker's own record is the trail."""
    from flow_sdk.builtin.agentic_process.launch_health import LaunchError  # noqa: PLC0415

    try:
        outcome = await target.driver.send(
            target.source, thread_key=target.thread_key, to=target.to,
            text=text, subject=target.subject, conversation_id=conversation_id,
        )
        logger.info("[channel-send] %s → %s %s (id=%s)", target.channel,
                    target.to, outcome.status.value, outcome.external_id or "?")
        if not outcome.drafted and not outcome.recorded:
            # Only meaningful for a real send: the mail IS gone, and only the
            # local copy is missing. Re-sending to fix bookkeeping would mail
            # the recipient twice. A DRAFT is never recorded by design, so
            # warning about it would fire on every reply.
            logger.warning("[channel-send] %s → %s delivered but NOT recorded locally",
                           target.channel, target.to)
    except LaunchError as exc:
        logger.error("[channel-send] %s → %s failed: %s", target.channel,
                     target.to, exc.as_dict())
    except Exception:  # noqa: BLE001
        logger.exception("[channel-send] %s → %s failed", target.channel, target.to)
