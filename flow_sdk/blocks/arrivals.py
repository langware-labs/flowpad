"""Wake a drain when its source ingests — instead of when its cadence next comes round.

A drain (``StreamInbox.pages``) polls on a cadence, which is right for a source
that must be asked; a pushed message (a webhook, a hub mirror) is already a row
the moment it lands, and waiting out the cadence is pure latency — three seconds
before a chat-like channel even starts its turn. ``ingest.*.item.created`` is
scoped to the source it landed in; a drain subscribes to its own source's and
wakes on it. The cadence stays the fallback, so a missed tag costs one cycle,
never a message.

Clear the event before the cycle's poll and drain, so an item that lands DURING
them wakes the next wait at once rather than falling in the gap.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
from typing import AsyncIterator


@contextlib.asynccontextmanager
async def arrivals(source_id: str) -> AsyncIterator[asyncio.Event]:
    """An event set whenever an item is ingested into *source_id*, for the duration of the block."""
    from flow_sdk.tags import on_tag, target_of  # noqa: PLC0415

    landed = asyncio.Event()

    async def _landed(_event) -> None:
        landed.set()

    unsubscribe = on_tag("ingest.*.item.created", _landed, scope=[target_of("data_source", source_id)])
    try:
        yield landed
    finally:
        unsubscribe()


#: The stop a drain obeys, carried in its context — tasks a drain starts (a merge's pumps) inherit it.
#: Set, a drain ends at its next wait between cycles: the one point where ending interrupts nothing
#: (no poll, no page read, no turn is half done). See :func:`stopping`.
_STOP: "contextvars.ContextVar[asyncio.Event | None]" = contextvars.ContextVar("drain_stop", default=None)


@contextlib.contextmanager
def stoppable(stop: asyncio.Event):
    """Drains started inside this block end at their next wait once *stop* is set."""
    token = _STOP.set(stop)
    try:
        yield stop
    finally:
        _STOP.reset(token)


def stopping() -> bool:
    """Whether the drain this code runs in has been asked to end."""
    stop = _STOP.get()
    return stop is not None and stop.is_set()


async def until(landed: asyncio.Event, cadence: float) -> bool:
    """Until *landed* is set, or *cadence* seconds — whichever is first. ``False`` when the drain
    has been asked to end (:func:`stoppable`) — the caller returns instead of cycling again."""
    stop = _STOP.get()
    if stop is None:
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(landed.wait(), cadence)
        return True
    if stop.is_set():
        return False
    waiters = [asyncio.ensure_future(landed.wait()), asyncio.ensure_future(stop.wait())]
    try:
        await asyncio.wait(waiters, timeout=cadence, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for waiter in waiters:
            waiter.cancel()
    return not stop.is_set()


__all__ = ["arrivals", "stoppable", "stopping", "until"]
