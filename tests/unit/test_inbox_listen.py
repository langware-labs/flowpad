"""``Inbox.listen()`` on a durable position — the at-least-once proof.

The property: an item handed out and never acked comes back after a restart, flagged; an
acked one never does; and outside a named workflow the loop behaves exactly as before.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import Delivered, EmailMessageSpec, Inbox, workflow
from flow_sdk.builtin.consumer_position import ConsumerPosition
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem, SourceItemSpec
from tests.utils.fake_source import scripted_provider

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _name() -> str:
    return f"w-{mint_uuid()}"


def _addr() -> str:
    return f"{mint_uuid()}@scripted.test"


async def _take(inbox: Inbox, n: int) -> list[Delivered]:
    """Pull *n* items from a fresh listen() and close it — a consumer that stops (or dies)."""
    agen = inbox.listen(poll_every=0)
    out: list[Delivered] = []
    try:
        while len(out) < n:
            out.append(await agen.__anext__())
    finally:
        await agen.aclose()
    return out


async def _drained(inbox: Inbox) -> bool:
    """True when one poll+drain yields nothing (the driver has no pages left)."""
    agen = inbox.listen(poll_every=0)
    try:
        import asyncio

        try:
            await asyncio.wait_for(agen.__anext__(), timeout=0.3)
            return False
        except asyncio.TimeoutError:
            return True
    finally:
        await agen.aclose()


# ── arrivals, not history ────────────────────────────────────────────────────


async def test_rows_present_before_the_first_listen_are_the_baseline():
    addr = _addr()
    with scripted_provider("scripted") as driver:
        inbox = Inbox(addr, provider="scripted")
        driver.push({"body": "old"})
        # Ingest the "old" page through a plain sync, before any position exists.
        await (await inbox._ensure_source()).sync()
        driver.push({"body": "new"})
        async with workflow(_name()):
            (item,) = await _take(inbox, 1)
    assert item.body == "new"


# ── the whole point ──────────────────────────────────────────────────────────


async def test_an_unacked_item_is_redelivered_after_a_restart_and_an_acked_one_is_not():
    addr, name = _addr(), _name()
    with scripted_provider("scripted") as driver:
        inbox = Inbox(addr, provider="scripted")
        driver.push({"body": "hello", "external_id": "<m1>"})

        async with workflow(name):
            (first,) = await _take(inbox, 1)          # handed out — then the process dies
            assert first.body == "hello" and first.redelivered is False

        async with workflow(name):                    # restart
            (again,) = await _take(inbox, 1)
            assert again.external_id == "<m1>"
            assert again.redelivered is True, "it was in flight when we died"
            await again.ack()
            assert again.acked

        async with workflow(name):                    # and once acked, gone for good
            assert await _drained(inbox)


async def test_ack_is_an_offset_that_commits_everything_before_it():
    addr, name = _addr(), _name()
    with scripted_provider("scripted") as driver:
        inbox = Inbox(addr, provider="scripted")
        driver.push({"body": "a"}, {"body": "b"}, {"body": "c"})
        async with workflow(name):
            a, b, c = await _take(inbox, 3)
            await c.ack()
            assert a.acked and b.acked
        async with workflow(name):
            assert await _drained(inbox)


async def test_outside_a_workflow_the_position_is_ephemeral():
    addr = _addr()
    with scripted_provider("scripted") as driver:
        inbox = Inbox(addr, provider="scripted")
        driver.push({"body": "x"})
        (item,) = await _take(inbox, 1)
        await item.ack()                                   # a no-op that still works
        source = await inbox._ensure_source()
    assert await ConsumerPosition.get_all({"data_source_id": str(source.id)}) == []


# ── filters are acked, never gaps ────────────────────────────────────────────


async def test_our_own_sent_copy_is_filtered_and_acked():
    addr, name = _addr(), _name()
    with scripted_provider("scripted") as driver:
        src = DataSource(
            name="pre", provider="scripted", config={"inbox": addr}, account_key="me@scripted.test"
        )
        await src.save()
        inbox = Inbox(addr, provider="scripted")
        driver.push({"body": "mine", "author": "me@scripted.test"}, {"body": "theirs"})
        async with workflow(name):
            (item,) = await _take(inbox, 1)
            assert item.body == "theirs"
            position = await ConsumerPosition.ensure_for(name, str(src.id))
            mine = next(i for i in await SourceItem.get_all({"data_source_id": str(src.id)}) if i.body == "mine")
            assert position.is_acked(mine), "a filtered row must not become a gap the drain stops at"


# ── shape ────────────────────────────────────────────────────────────────────


async def test_the_envelope_delegates_to_the_item():
    addr = _addr()
    with scripted_provider("scripted") as driver:
        inbox = Inbox(addr, provider="scripted")
        driver.push({"body": "q", "name": "Coffee?", "author": "alice@example.com", "thread_key": "t1"})
        (m,) = await _take(inbox, 1)
    assert isinstance(m, Delivered) and isinstance(m.item, SourceItemSpec)
    reply = EmailMessageSpec.reply_to(m, body="yes")
    assert reply.to == ["alice@example.com"] and reply.thread_key == "t1"


async def test_the_drain_is_paged(monkeypatch):
    addr = _addr()
    calls = []
    original = SourceItem.page_after

    async def spy(cls, *a, **kw):
        calls.append(kw.get("limit"))
        return await original.__func__(cls, *a, **kw)

    monkeypatch.setattr(SourceItem, "page_after", classmethod(spy))
    with scripted_provider("scripted") as driver:
        inbox = Inbox(addr, provider="scripted")
        driver.push(*[{"body": f"m{i}"} for i in range(250)])
        agen = inbox.listen(poll_every=0, page=100)
        got = []
        try:
            while len(got) < 250:
                got.append(await agen.__anext__())
        finally:
            await agen.aclose()
    assert len({g.external_id for g in got}) == 250
    assert len(calls) >= 3 and all(c == 100 for c in calls)
