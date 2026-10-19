"""``merge_iterators(iterators)`` — one async iterator over several, in arrival order.

A function, like ``asyncio.gather``: a pump runs each iterator and hands its items to one queue
the caller reads. Not ``aiostream.merge``, because a merge must not reorder or batch what a source
handed over — the item itself says where it came from, and the consumer's ack is per item.

A pump holds at most one item out: it hands one over and waits for the consumer to come back
for the next before pulling more, so a durable in-flight stamp stays honest about what the
consumer was actually handed. The queue itself is unbounded so that control messages (a pump
finishing, a pump failing) never block — a bounded queue deadlocked a closing consumer against
a cancelled pump's own farewell.

One iterator erroring is loud: the merge cancels its siblings and re-raises rather than quietly
dropping a source.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, AsyncIterator, Sequence, TypeVar

T = TypeVar("T")


@dataclass
class _Handed:
    item: Any
    gate: asyncio.Event      # the consumer sets it once it comes back for the next item


@dataclass
class _Failed:
    exc: BaseException


class _Finished:
    pass


async def merge_iterators(iterators: Sequence[AsyncIterator[T]]) -> AsyncIterator[T]:
    """Yield from every iterator as items arrive, in arrival order."""
    if not iterators:
        return
    if len(iterators) == 1:
        async for item in iterators[0]:
            yield item
        return

    queue: asyncio.Queue = asyncio.Queue()

    async def pump(iterator: AsyncIterator[T]) -> None:
        gate = asyncio.Event()
        try:
            async for item in iterator:
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

    tasks = [asyncio.create_task(pump(it), name=f"merge:{it!r}") for it in iterators]
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


__all__ = ["merge_iterators"]
