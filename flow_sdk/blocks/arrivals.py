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


async def until(landed: asyncio.Event, cadence: float) -> None:
    """Until *landed* is set, or *cadence* seconds — whichever is first."""
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(landed.wait(), cadence)


__all__ = ["arrivals", "until"]
