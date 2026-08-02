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
from typing import Any, Optional

logger = logging.getLogger(__name__)


class ChannelSendUnavailable(Exception):
    """This conversation cannot be replied to through a channel."""


async def resolve_reply_target(conversation_id: str,
                               reply_to_message_id: Optional[str] = None) -> dict[str, Any]:
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
    from flow_sdk.ingest.driver import get_driver  # noqa: PLC0415

    messages = await FlowMessage.get_all({"match": {"conversation_id": conversation_id}})
    sourced = [m for m in messages if getattr(m, "origin", None) and m.origin.kind]
    if not sourced:
        raise ChannelSendUnavailable("this conversation did not come from a channel")

    # Reply to the named message when given one, else the newest — which is what
    # "reply" means with no further qualification.
    target = None
    if reply_to_message_id:
        target = next((m for m in sourced if str(m.id) == reply_to_message_id), None)
    if target is None:
        target = max(sourced, key=lambda m: str(getattr(m, "created_date", "") or ""))

    origin = target.origin
    source = await DataSource.get_one({"id": origin.data_source_id})
    if source is None:
        raise ChannelSendUnavailable("the data source this arrived through is gone")

    driver = get_driver(source.provider)
    if driver is None or not getattr(driver, "sends", False):
        raise ChannelSendUnavailable(
            f"the {origin.kind} transport cannot send")

    item = await SourceItem.get_one({"id": origin.source_item_id})
    to = str(getattr(item, "author_external_id", "") or "").strip()
    if not to:
        # No sender address means nowhere to send. Better to refuse than to
        # spawn a worker that will guess a recipient.
        raise ChannelSendUnavailable("the message being replied to carries no sender address")

    return {
        "driver": driver,
        "source": source,
        "channel": origin.kind,
        "to": to,
        "thread_key": str(getattr(item, "thread_key", "") or ""),
        "subject": str(getattr(item, "name", "") or ""),
        "reply_to": target,
    }


async def dispatch_channel_reply(conversation_id: str, *, text: str,
                                 reply_to_message_id: Optional[str] = None):
    """Accept a reply and start it. Returns once DISPATCHED."""
    from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

    try:
        target = await resolve_reply_target(conversation_id, reply_to_message_id)
    except ChannelSendUnavailable as exc:
        return ApiFailResponse(message=str(exc))

    task = asyncio.create_task(
        _run_send(conversation_id, target, text),
        name=f"channel_send_{conversation_id[:8]}",
    )
    # Hold a reference: a bare create_task can be garbage-collected mid-flight,
    # which would silently drop a send the user believes was accepted.
    _INFLIGHT.add(task)
    task.add_done_callback(_INFLIGHT.discard)

    return ApiSuccessResponse(data={
        "accepted": True,
        "channel": target["channel"],
        "to": target["to"],
    })


#: Strong references to running sends — see the note in `dispatch_channel_reply`.
_INFLIGHT: "set[asyncio.Task]" = set()


async def _run_send(conversation_id: str, target: dict, text: str) -> None:
    """The background half. Never raises — a failed reply must not take down
    the request that started it, and the worker's own record is the trail."""
    from flow_sdk.builtin.agentic_process.launch_health import LaunchError  # noqa: PLC0415

    try:
        outcome = await target["driver"].send(
            target["source"],
            thread_key=target["thread_key"],
            to=target["to"],
            text=text,
            subject=target["subject"],
        )
        logger.info("[channel-send] %s → %s ok (external_id=%s, recorded=%s)",
                    target["channel"], target["to"],
                    outcome.external_id or "?", outcome.recorded)
        if not outcome.recorded:
            # The mail IS sent. Only the local copy is missing, and re-sending
            # to fix bookkeeping would mail the recipient twice.
            logger.warning("[channel-send] %s → %s delivered but NOT recorded locally",
                           target["channel"], target["to"])
    except LaunchError as exc:
        logger.error("[channel-send] %s → %s failed: %s", target["channel"],
                     target["to"], exc.as_dict())
    except Exception:  # noqa: BLE001
        logger.exception("[channel-send] %s → %s failed", target["channel"], target["to"])
