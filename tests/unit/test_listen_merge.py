"""``listen(*sources)`` — several sources, one loop, and every ack stays with its own source."""

from __future__ import annotations

import asyncio

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import Inbox, listen, workflow
from flow_sdk.builtin.consumer_position import ConsumerPosition
from tests.utils.fake_source import scripted_provider

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _name() -> str:
    return f"w-{mint_uuid()}"


async def _take(agen, n: int):
    out = []
    try:
        while len(out) < n:
            out.append(await agen.__anext__())
    finally:
        await agen.aclose()
    return out


async def test_items_from_two_sources_arrive_and_each_ack_moves_only_its_own_position():
    with scripted_provider("alpha") as a, scripted_provider("beta") as b:
        a.push({"body": "from alpha"})
        b.push({"body": "from beta"})
        one, two = Inbox(f"{mint_uuid()}@a", provider="alpha"), Inbox(f"{mint_uuid()}@b", provider="beta")
        name = _name()
        async with workflow(name):
            items = await _take(listen(one, two, poll_every=0), 2)
            bodies = {i.body: i for i in items}
            assert set(bodies) == {"from alpha", "from beta"}
            await bodies["from alpha"].ack()

            src_a, src_b = await one._ensure_source(), await two._ensure_source()
            pa = await ConsumerPosition.ensure_for(name, str(src_a.id))
            pb = await ConsumerPosition.ensure_for(name, str(src_b.id))
            assert pa.watermark() is not None, "alpha's ack landed"
            assert pb.watermark() is None, "beta's did not move"


async def test_breaking_out_leaves_no_pump_running():
    with scripted_provider("alpha") as a, scripted_provider("beta") as b:
        a.push({"body": "x"})
        b.push({"body": "y"})
        before = {t for t in asyncio.all_tasks()}
        await _take(listen(Inbox(f"{mint_uuid()}@a", provider="alpha"),
                           Inbox(f"{mint_uuid()}@b", provider="beta"), poll_every=0), 1)
        await asyncio.sleep(0)
        leaked = [t for t in asyncio.all_tasks() - before if not t.done() and t.get_name().startswith("listen:")]
        assert leaked == []


async def test_one_source_raising_surfaces_and_cancels_the_other():
    class Broken:
        async def listen(self, *, poll_every=None):
            raise ValueError("this source is broken")
            yield  # pragma: no cover — makes this an async generator

    with scripted_provider("alpha") as a:
        a.push({"body": "x"})
        with pytest.raises(ValueError, match="broken"):
            await _take(listen(Inbox(f"{mint_uuid()}@a", provider="alpha"), Broken(), poll_every=0), 5)
        await asyncio.sleep(0)
        assert not [t for t in asyncio.all_tasks() if t.get_name().startswith("listen:") and not t.done()]


async def test_a_single_source_is_passed_straight_through():
    with scripted_provider("alpha") as a:
        a.push({"body": "only"})
        (item,) = await _take(listen(Inbox(f"{mint_uuid()}@a", provider="alpha"), poll_every=0), 1)
    assert item.body == "only"
