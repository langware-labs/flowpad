"""An agent's serve loop is a consumer, never a poller.

It shipped polling: its drain asked the provider on every cycle (every 3 s), so an
agent-owned Gmail or Slack source went from its 5-minute interval to 3 s — on every
machine holding it, parked and disabled sources included. Now the loop only reads
what the app's own ingest lands (a push at once, a pull at the source's pace) and
says it is waiting the way a viewer does: ``DataSource.note_attention``, the one
demand signal — a driver that allows it gets its fast lane, no other goes faster.

A user's own ``listen()`` loop keeps polling; that is its documented contract
(``pipes.md``) and is pinned by ``test_stream_inbox_pages.py``.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.blocks import StreamInbox, workflow
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.consumer_position import ConsumerPosition
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.ingest.sync import sync_source
from tests.utils.fake_source import scripted_provider

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _messages(n: int, tag: str) -> list[dict]:
    return [{"body": f"{tag}{i:03d}", "author": "customer@example.com", "thread_key": f"{tag}{i}"} for i in range(n)]


@pytest.fixture
def no_poll(monkeypatch):
    """Every poll a consumer makes — asserted empty at teardown. Recorded, not raised: a raise
    inside a loop task is swallowed with the task, and the test would pass on a polling loop."""
    polls: list = []

    async def record(source, *_a, **_k):
        polls.append(str(source.id))
        return False

    monkeypatch.setattr("flow_sdk.ingest.poller.poll_source", record)
    yield polls
    assert polls == [], f"a consumer polled the provider {len(polls)} time(s)"


@pytest.fixture
def leases(monkeypatch):
    """The attention leases armed, recorded instead of driving the poller's lane."""
    armed: list[tuple[str, int]] = []
    monkeypatch.setattr("flow_sdk.ingest.poller.note_attention", lambda source_id, cadence: armed.append((source_id, cadence)))
    return armed


async def _drain_only(source, name: str, *, poll_every: float):
    """A drain-only loop over *source* whose position already exists (so what lands next is an arrival)."""
    await ConsumerPosition.ensure_for(name, str(source.id), baseline=await SourceItem.newest_for(str(source.id)))
    return StreamInbox.of(source).pages(poll_every=poll_every, poll=False)


async def _bodies(drain, n: int) -> list[str]:
    """The first *n* message bodies the drain hands over, however they are paged."""
    bodies: list[str] = []
    while len(bodies) < n:
        bodies += [m.body for m in await drain.__anext__()]
    return bodies


async def test_a_drain_only_loop_never_polls_and_a_pushed_item_wakes_it_at_once(mail_db, no_poll):
    with scripted_provider(f"drain-{uuid.uuid4().hex[:6]}") as script:
        source = await StreamInbox(f"{uuid.uuid4().hex[:6]}@x", provider=script.provider).ensure_source()
        name = f"drain-{uuid.uuid4()}"
        async with workflow(name):
            drain = await _drain_only(source, name, poll_every=30)  # the fallback is far away
            got = asyncio.ensure_future(_bodies(drain, 2))
            await asyncio.sleep(0)
            script.push(*_messages(2, "p"))
            await sync_source(source)  # the app's own ingest — the heartbeat, a push
            bodies = await asyncio.wait_for(got, 5)  # well inside the 30 s fallback: an arrival woke it
            await drain.aclose()

        assert bodies == ["p000", "p001"]
        assert script.fetches == 1, "the one fetch was the app's ingest, not the loop"


async def test_a_backfill_that_announces_no_arrival_is_read_on_the_fallback(mail_db, no_poll):
    """Over 30 items is a BACKFILL, which emits no per-item tag — the DB re-read still finds them."""
    with scripted_provider(f"backfill-{uuid.uuid4().hex[:6]}") as script:
        source = await StreamInbox(f"{uuid.uuid4().hex[:6]}@x", provider=script.provider).ensure_source()
        name = f"backfill-{uuid.uuid4()}"
        async with workflow(name):
            drain = await _drain_only(source, name, poll_every=0.05)
            got = asyncio.ensure_future(_bodies(drain, 40))
            await asyncio.sleep(0)
            script.push(*_messages(40, "b"))
            await sync_source(source)
            bodies = await asyncio.wait_for(got, 5)
            await drain.aclose()

        assert len(bodies) == 40


async def test_the_serve_loop_never_asks_the_provider(mail_db, no_poll, leases):
    with scripted_provider(f"served-{uuid.uuid4().hex[:6]}") as script:
        agent = Agent(name=f"served-{uuid.uuid4().hex[:8]}", worker_type="claude")
        await agent.save()
        source = await StreamInbox(f"{uuid.uuid4().hex[:6]}@x", provider=script.provider, owner=agent).ensure_source()
        loop = asyncio.ensure_future(
            agent_serve.serve(agent, await agent.local_deployment(), sources=[source], poll_every=0.01)
        )
        await asyncio.sleep(0.3)  # ~30 drain cycles
        loop.cancel()
        await asyncio.gather(loop, return_exceptions=True)

    assert script.fetches == 0
    assert leases == [], "a driver that declares no fast lane gets no lease — its interval stands"


async def test_while_it_serves_a_fast_lane_driver_the_loop_holds_its_lease(mail_db, no_poll, leases):
    with scripted_provider(f"fast-{uuid.uuid4().hex[:6]}") as script:
        DRIVERS.get(script.provider).cls.attention_poll_seconds = 5
        agent = Agent(name=f"fast-{uuid.uuid4().hex[:8]}", worker_type="claude")
        await agent.save()
        source = await StreamInbox(f"{uuid.uuid4().hex[:6]}@x", provider=script.provider, owner=agent).ensure_source()
        source.status = "active"  # a scripted source starts in setup, which is never polled
        await source.save()
        loop = asyncio.ensure_future(agent_serve.serve(agent, await agent.local_deployment(), sources=[source]))
        await asyncio.sleep(0.05)
        loop.cancel()
        await asyncio.gather(loop, return_exceptions=True)

    assert leases == [(str(source.id), 5)], "the same lease a viewer holds — the poller's lane does the polling"
    assert script.fetches == 0


@pytest.mark.parametrize(
    ("provider", "status", "health", "armed"),
    [
        ("telegram", "active", "ok", 5),
        ("slack", "active", "ok", None),
        ("telegram", "active", "config_error", None),
        ("telegram", "disabled", "ok", None),
    ],
    ids=["fast-lane-driver", "no-fast-lane", "parked", "disabled"],
)
async def test_note_attention_arms_only_what_may_be_polled_faster(leases, provider, status, health, armed):
    source = DataSource(name=f"s-{uuid.uuid4().hex[:6]}", provider=provider, channel=provider, status=status, health=health)

    assert source.note_attention() == armed
    assert leases == ([(str(source.id), armed)] if armed else [])
