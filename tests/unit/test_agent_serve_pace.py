"""An agent answers its channels at the channel's own pace — its serve loop never polls.

A real agent (``MockDriver`` from ``tests/utils/mock_worker.py``: a real headless turn that
answers "Mock reply: …", no model) served by the app's own ``AgentServer``, over the channel
drivers' own ``Double``s:

* a pull channel with no fast lane (Slack) is asked only when the heartbeat says it is due —
  the agent answers the message that poll brought in, and the loop itself asks nothing;
* a pull channel with a fast lane (Telegram, ``attention_poll_seconds = 5``) is polled by the
  poller's attention lane while the agent serves it, so the agent answers within that cadence;
* a parked source is asked by nobody, however long it is served.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import AgentServer
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.ingest import sync as sync_module
from flow_sdk.ingest.poller import dispatch_due_sources
from flow_sdk.ingest.testing import make_data_source
from tests.unit._stream_inbox_matrix import double_for
from tests.utils.mock_worker import MockDriver

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval


@pytest.fixture
def worker(monkeypatch, tmp_path):
    driver = MockDriver(tmp_path / "mock-transcripts")
    monkeypatch.setattr("flow_sdk.builtin.agentic_process.agentic_process.get_driver", lambda _t: driver)
    return driver


@pytest.fixture
def syncs(monkeypatch):
    """Every poll of a source — the provider being asked — recorded by source id."""
    seen: list[str] = []
    real = sync_module.sync_source

    async def counted(source, *a, **k):
        seen.append(str(source.id))
        return await real(source, *a, **k)

    monkeypatch.setattr(sync_module, "sync_source", counted)
    return seen


async def _served(provider: str, double, monkeypatch, syncs: "list | None" = None, **fields):
    """An agent owning *provider*'s source over *double*, and the app's supervisor serving it.

    *syncs* is emptied the moment before the loop starts: every poll from then on counts."""
    agent = Agent(name=f"pace {provider} {uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.")
    await agent.save()
    monkeypatch.setattr(DataDriver.loaded(provider), "credentials_for", double.credentials)
    source = make_data_source(
        provider, name=f"pace {provider} {uuid.uuid4().hex[:6]}", config=dict(double.config), owner=agent.typeid,
        status=SourceStatus.ACTIVE.value, inbound_allowed_senders=[double.sender], **dict(double.fields), **fields,
    )
    await source.save()
    await sync_module.sync_source(source)  # its first position: what the double holds now is history
    if syncs is not None:
        syncs.clear()
    server = AgentServer(serve_channels=True)
    await server.reconcile()
    assert str(source.id) in server.serving().get(str((await agent.local_deployment()).id), frozenset())
    return agent, source, server


async def _replied(double, *, within: float) -> list[dict]:
    for _ in range(int(within / 0.05)):
        if double.sent():
            return double.sent()
        await asyncio.sleep(0.05)
    return double.sent()


@pytest.mark.long  # 3.7s: one real MockWorker turn waits the transcript's 2s settle
async def test_a_pull_channel_without_a_fast_lane_is_asked_only_when_it_is_due(worker, syncs, monkeypatch):
    with double_for("slack") as double:
        agent, source, server = await _served("slack", double, monkeypatch, syncs)
        try:
            double.deliver("is anyone there?", sender=double.sender)
            await asyncio.sleep(0.5)
            assert [s for s in syncs if s == str(source.id)] == [], "the serve loop asked the provider"
            assert double.sent() == [], "nothing answered a message nobody has fetched"

            source.next_poll_at = None  # due, as the heartbeat finds it at its interval
            await source.save_runtime()
            assert str(source.id) in await dispatch_due_sources()  # one heartbeat tick
            (reply,) = await _replied(double, within=10)
        finally:
            await server.stop()
            await agent.delete()

    assert reply["text"].startswith("Mock reply") and worker.received_prompts == ["is anyone there?"]
    assert syncs.count(str(source.id)) == 1, "the heartbeat's one poll — and nothing else"


@pytest.mark.long  # 7.7s: the lane's 5s cadence plus one MockWorker turn
async def test_a_fast_lane_channel_is_polled_by_the_lane_while_an_agent_serves_it(worker, monkeypatch):
    with double_for("telegram") as double:
        agent, source, server = await _served("telegram", double, monkeypatch)
        try:
            double.deliver("where is my order?", sender=double.sender)
            (reply,) = await _replied(double, within=12)  # the lane polls every 5s
        finally:
            await server.stop()
            await agent.delete()

    assert reply["text"].startswith("Mock reply") and worker.received_prompts == ["where is my order?"]
    polls = [m for m, _ in double.bot.requests if m == "getUpdates"]
    assert 2 <= len(polls) <= 4, f"the lane's pace (the first pass, then one per 5s), not a 3s loop: {len(polls)}"


async def test_a_parked_source_is_asked_by_nobody_however_long_it_is_served(worker, syncs, monkeypatch):
    with double_for("slack") as double:
        agent, source, server = await _served("slack", double, monkeypatch, syncs)
        try:
            source.health = "config_error"  # parked: needs a person
            await source.save()
            await server.reconcile()
            double.deliver("hello?", sender=double.sender)
            source.next_poll_at = None
            await source.save_runtime()
            dispatched = await dispatch_due_sources()
            await asyncio.sleep(0.3)
        finally:
            await server.stop()
            await agent.delete()

    assert str(source.id) not in dispatched, "the heartbeat skips a parked source"
    assert [s for s in syncs if s == str(source.id)] == [], "and so does every consumer"
    assert double.sent() == [] and worker.received_prompts == []
