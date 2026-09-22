"""Which channels an agent placement serves, and the supervisor that keeps each serving.

An agent answers a channel from exactly one place: the source's ``answer_place``
names it, and a source that names none is answered wherever it is held. The
``AgentServer`` runs one serve loop per placement over precisely those sources —
restarted when the set changes (a channel bound later is served), cancelled when
the placement stops being one this machine answers on.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import AgentServer, answered_sources
from flow_sdk.builtin.data_source import DataSource

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _agent() -> Agent:
    agent = Agent(name=f"served-{uuid.uuid4().hex[:8]}", worker_type="claude")
    await agent.save()
    return agent


async def _channel(agent: Agent, *, answer_place: str | None = None) -> DataSource:
    """A Slack channel the agent owns — a message source (its driver sends), and an agent may hold many."""
    channel_id = f"C{uuid.uuid4().hex[:10].upper()}"
    source = DataSource(
        name=f"slack {channel_id}",
        provider="slack",
        channel="slack",
        config={"channel": {"id": channel_id, "name": channel_id.lower()}},
        owner=agent.typeid,
        answer_place=answer_place,
    )
    await source.save()
    return source


def _ids(sources) -> set[str]:
    return {str(s.id) for s in sources}


async def test_a_source_is_served_where_its_answer_place_says(mail_db):
    agent = await _agent()
    here = await agent.local_deployment()
    anywhere = await _channel(agent)
    pinned_here = await _channel(agent, answer_place=here.id)
    elsewhere = await _channel(agent, answer_place=str(uuid.uuid4()))

    served = _ids(await answered_sources(agent, here))

    assert {str(anywhere.id), str(pinned_here.id)} <= served
    assert str(elsewhere.id) not in served


@pytest.fixture
def loops(monkeypatch):
    """The serve loop replaced by one that records what it was given and waits to be cancelled."""
    started: list[set[str]] = []

    async def serve(agent, deployment, *, sources=None, poll_every=None):
        started.append(_ids(sources))
        await asyncio.Event().wait()

    monkeypatch.setattr(agent_serve, "serve", serve)
    return started


async def test_each_placement_serves_its_sources_and_a_new_channel_restarts_it(mail_db, loops):
    agent = await _agent()
    deployment = await agent.local_deployment()
    first = await _channel(agent)
    server = AgentServer(serve_channels=True)
    try:
        await server.reconcile()
        await asyncio.sleep(0)
        assert server.serving()[str(deployment.id)] == {str(first.id)}

        await server.reconcile()  # nothing changed: the running loop is kept
        await asyncio.sleep(0)
        assert len(loops) == 1

        second = await _channel(agent)
        await server.reconcile()
        await asyncio.sleep(0)
        assert server.serving()[str(deployment.id)] == {str(first.id), str(second.id)}
        assert loops[-1] == {str(first.id), str(second.id)}
    finally:
        await server.stop()


async def test_a_placement_switched_off_stops_serving(mail_db, loops):
    agent = await _agent()
    deployment = await agent.local_deployment()
    await _channel(agent)
    server = AgentServer(serve_channels=True)
    try:
        await server.reconcile()
        assert str(deployment.id) in server.serving()

        agent.enabled = False
        await agent.save()
        await server.reconcile()
        await asyncio.sleep(0)

        assert str(deployment.id) not in server.serving()
    finally:
        await server.stop()


async def test_without_channel_loops_only_the_chat_endpoint_is_kept(mail_db, loops):
    agent = await _agent()
    await agent.local_deployment()
    await _channel(agent)
    server = AgentServer(serve_channels=False)

    await server.reconcile()

    assert server.serving() == {}
    assert loops == []


async def test_an_agent_that_owns_a_channel_is_served_here_without_being_placed_first(mail_db, loops):
    """The app answers an agent's channel with nothing of the owner's running — not even a
    placement made beforehand: owning the source is what puts the agent on this machine."""
    agent = await _agent()
    source = await _channel(agent)
    server = AgentServer(serve_channels=True)
    try:
        await server.reconcile()
        await asyncio.sleep(0)

        placement = await agent.local_deployment()
        assert server.serving()[str(placement.id)] == {str(source.id)}
    finally:
        await server.stop()


async def test_a_polls_runtime_write_is_not_news_but_a_pause_is(mail_db, loops):
    """Every poll writes the source's runtime fields; reconciling on each would run the
    supervisor every few seconds per channel. Only what serving depends on counts."""
    agent = await _agent()
    source = await _channel(agent)
    server = AgentServer(serve_channels=True)
    try:
        await server.reconcile()
        ran = []

        async def counted():
            ran.append(1)

        server.reconcile = counted
        source.next_poll_at = None
        await source.save_runtime()
        server._touch("data_source", str(source.id))
        await server._pending
        assert ran == []

        source.status = "disabled"
        await source.save()
        server._touch("data_source", str(source.id))
        await server._pending
        assert ran == [1]
    finally:
        await server.stop()
