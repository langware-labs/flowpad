"""``merge_iterators``: arrival order, one item in flight per pump, a failure is loud."""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.utils.aiter_merge import merge_iterators

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


async def _gen(*items, gate: asyncio.Event | None = None):
    for item in items:
        if gate is not None:
            await gate.wait()
        yield item


async def test_empty_and_single_inputs():
    assert [x async for x in merge_iterators([])] == []
    assert [x async for x in merge_iterators([_gen(1, 2)])] == [1, 2]


async def test_items_arrive_in_arrival_order_across_pumps():
    slow = asyncio.Event()
    got = []
    async for x in merge_iterators([_gen("a1", "a2", gate=slow), _gen("b1", "b2")]):
        got.append(x)
        if x == "b2":
            slow.set()
    assert got[:2] == ["b1", "b2"] and sorted(got[2:]) == ["a1", "a2"]


async def test_a_pump_holds_one_item_until_the_consumer_comes_back():
    pulled = []

    async def counting():
        for n in range(3):
            pulled.append(n)
            yield n

    agen = merge_iterators([counting(), _gen()])
    first = await agen.__anext__()
    await asyncio.sleep(0)
    assert first == 0 and pulled == [0], "the pump pulled ahead of the consumer"
    await agen.aclose()


async def test_one_failing_iterator_cancels_the_others_and_raises():
    forever = asyncio.Event()

    async def boom():
        yield "x"
        raise RuntimeError("driver refused")

    got = []
    with pytest.raises(RuntimeError, match="driver refused"):
        async for x in merge_iterators([boom(), _gen("y", gate=forever)]):
            got.append(x)
    assert got == ["x"]
    assert not [t for t in asyncio.all_tasks() if t.get_name().startswith("merge:")], "a pump outlived the merge"


async def test_closing_the_merge_leaves_no_pump_running():
    forever = asyncio.Event()
    agen = merge_iterators([_gen("a"), _gen("b", gate=forever)])
    assert await agen.__anext__() == "a"
    await agen.aclose()
    assert not [t for t in asyncio.all_tasks() if t.get_name().startswith("merge:")]
