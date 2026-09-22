"""A drain asked to stop ends at its next wait between cycles — never mid-cycle (``blocks/arrivals``)."""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.blocks.arrivals import stoppable, stopping, until
from flow_sdk.utils.aiter_merge import merge_iterators

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(5)]  # do not increase timeout without approval


async def test_until_without_a_stop_is_the_plain_wait():
    landed = asyncio.Event()
    landed.set()
    assert await until(landed, 5) is True


async def test_a_stop_wakes_the_wait_and_says_end():
    stop = asyncio.Event()
    with stoppable(stop):
        waiting = asyncio.ensure_future(until(asyncio.Event(), 60))
        await asyncio.sleep(0)
        assert not stopping()
        stop.set()
        assert await waiting is False and stopping()
        assert await until(asyncio.Event(), 60) is False, "a stopped drain never waits again"


async def test_every_pump_of_a_merge_obeys_the_stop_and_finishes_its_cycle():
    """The pumps inherit the stop; a cycle in progress completes, then the merge ends on its own."""
    stop = asyncio.Event()
    cycles: dict[str, int] = {"a": 0, "b": 0}

    async def drain(name):
        while True:
            cycles[name] += 1
            await asyncio.sleep(0)       # the cycle's work — never interrupted
            yield name
            if not await until(asyncio.Event(), 60):
                return

    with stoppable(stop):
        seen = []
        async for item in merge_iterators([drain("a"), drain("b")]):
            seen.append(item)
            if len(seen) == 2:
                stop.set()
    assert sorted(seen) == ["a", "b"] and cycles == {"a": 1, "b": 1}
