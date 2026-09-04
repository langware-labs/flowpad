"""``listen(*sources)`` — one loop over several sources, each item still carrying ITS ack.

A function, like ``asyncio.gather``: pumps run each source's own ``listen()`` and hand items to
one queue the caller iterates. Not ``aiostream.merge``, because a merge erases which source an
item came from — and the ack IS the source. Each ``Delivered`` keeps its position, so acking one
never touches another source's.

A pump holds at most one item out: it hands one over and waits for the consumer to come back
for the next before pulling more, so the durable in-flight stamp stays honest about what the
consumer was actually handed. The queue itself is unbounded so that control messages (a pump
finishing, a pump failing) never block — a bounded queue deadlocked a closing consumer against
a cancelled pump's own farewell.

One source erroring is loud. ``sync`` never raises — a provider failure is health, not an
exception — so an exception out of a pump is a bug or a driver refusing (``ValueError`` on a
send), and the merge cancels its siblings and re-raises it rather than quietly dropping a source.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, AsyncIterator

from flow_sdk.blocks.delivery import Delivered


@dataclass
class _Handed:
    item: Delivered
    gate: asyncio.Event      # the consumer sets it once it comes back for the next item


@dataclass
class _Failed:
    exc: BaseException


class _Finished:
    pass


async def listen(*sources: Any, poll_every: "float | None" = None) -> AsyncIterator[Delivered]:
    """Yield from every source's ``listen()`` as items arrive, in arrival order."""
    if not sources:
        return
    if len(sources) == 1:
        async for item in sources[0].listen(poll_every=poll_every):
            yield item
        return

    queue: asyncio.Queue = asyncio.Queue()

    async def pump(source) -> None:
        gate = asyncio.Event()
        try:
            async for item in source.listen(poll_every=poll_every):
                gate.clear()
                queue.put_nowait(_Handed(item, gate))
                await gate.wait()
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 — carried to the consumer, not swallowed
            queue.put_nowait(_Failed(exc))
            raise
        finally:
            queue.put_nowait(_Finished())

    tasks = [asyncio.create_task(pump(s), name=f"listen:{s!r}") for s in sources]
    live = len(tasks)
    try:
        while live:
            got = await queue.get()
            if isinstance(got, _Finished):
                live -= 1
            elif isinstance(got, _Failed):
                raise got.exc
            else:
                yield got.item
                got.gate.set()
    finally:
        # Each pump closes its own generator in its own task — an async generator must be
        # finalized where it runs — so cancelling the pump is the whole of the cleanup.
        for task in tasks:
            if not task.done():
                task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 — teardown
                pass


__all__ = ["listen"]
