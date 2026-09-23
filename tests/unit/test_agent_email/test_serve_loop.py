"""Which channels a deployment answers, and the supervisor that keeps each running deployment's process up.

An agent answers a channel from exactly one place: the source's ``answer_place`` names it, and a
source that names none is the DEFAULT local deployment's (slot ``""``) — never a second one's, or
two processes would answer it. A running local deployment is a process (``builtin/agent_loop``);
the ``AgentServer`` starts it, adopts it alive after a restart, and stops it when the deployment
stops serving or its agent is switched off. The process itself is faked here
(``deployment_process.start/alive/stop``); ``tests/long_tests/test_local_deployment_process.py``
runs real ones.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin import deployment_process
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_serve import AgentServer, answered_sources, polled_by_a_deployment
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.deployment import Deployment

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


async def test_a_source_is_answered_where_its_answer_place_says(mail_db):
    agent = await _agent()
    here = await agent.local_deployment()
    anywhere = await _channel(agent)
    pinned_here = await _channel(agent, answer_place=here.id)
    elsewhere = await _channel(agent, answer_place=str(uuid.uuid4()))

    served = _ids(await answered_sources(agent, here))

    assert {str(anywhere.id), str(pinned_here.id)} <= served
    assert str(elsewhere.id) not in served


async def test_a_second_local_deployment_answers_only_what_names_it(mail_db):
    agent = await _agent()
    first = await agent.run_locally()
    second = await agent.run_locally()
    unplaced = await _channel(agent)
    pinned = await _channel(agent, answer_place=second.id)

    assert (first.slot, second.slot) == ("", "2")
    assert str(unplaced.id) in _ids(await answered_sources(agent, first))
    assert _ids(s for s in await answered_sources(agent, second) if s.provider == "slack") == {str(pinned.id)}


@pytest.fixture
def processes(monkeypatch):
    """The deployment process faked: ``alive`` is whatever ``start`` started and ``stop`` did not stop."""
    running: dict[str, int] = {}
    started: list[str] = []

    def start(deployment):
        started.append(str(deployment.id))
        running[str(deployment.id)] = len(started)
        return {"flowpad.process.pid": str(len(started))}

    def alive(deployment):
        return str(deployment.id) in running

    def stop(deployment):
        running.pop(str(deployment.id), None)
        return True

    monkeypatch.setattr(deployment_process, "start", start)
    monkeypatch.setattr(deployment_process, "alive", alive)
    monkeypatch.setattr(deployment_process, "stop", stop)
    return running, started


async def test_a_running_deployment_gets_its_process_once(mail_db, processes):
    running, started = processes
    agent = await _agent()
    deployment = await agent.run_locally()
    server = AgentServer()

    await server.reconcile()
    await server.reconcile()  # alive: kept, never a twin

    assert started == [str(deployment.id)] and server.running() == {str(deployment.id)}
    assert deployment_process.recorded(await Deployment.get_by_id(deployment.id)).pid == 1, "recorded on the deployment"


async def test_a_process_left_by_a_previous_app_is_adopted_not_doubled(mail_db, processes):
    running, started = processes
    agent = await _agent()
    deployment = await agent.run_locally()
    running[str(deployment.id)] = 99  # alive before this server existed

    server = AgentServer()
    await server.reconcile()

    assert started == [] and server.running() == {str(deployment.id)}


async def test_a_process_that_died_is_started_again(mail_db, processes):
    running, started = processes
    agent = await _agent()
    deployment = await agent.run_locally()
    server = AgentServer()
    await server.reconcile()

    running.clear()  # it died on its own
    await server.reconcile()

    assert started == [str(deployment.id), str(deployment.id)]


async def test_stopping_serving_or_switching_the_agent_off_stops_the_process(mail_db, processes):
    running, _started = processes
    agent = await _agent()
    first = await agent.run_locally()
    second = await agent.run_locally()
    server = AgentServer()
    await server.reconcile()
    assert set(running) == {str(first.id), str(second.id)}

    first.serving = False
    await first.save()
    await server.reconcile()
    assert set(running) == {str(second.id)}

    agent.enabled = False
    await agent.save()
    await server.reconcile()
    assert running == {} and server.running() == set()


async def test_a_placement_that_does_not_run_gets_no_process(mail_db, processes):
    """``local_deployment()`` is where processes are spawned through; it runs no loop of its own."""
    _running, started = processes
    agent = await _agent()
    await agent.local_deployment()
    await _channel(agent)

    await AgentServer().reconcile()

    assert started == []


async def test_in_the_test_tier_no_process_is_started_but_the_chat_is_made(mail_db, processes):
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint

    _running, started = processes
    agent = await _agent()
    deployment = await agent.deploy("local")
    deployment.serving = True
    await deployment.save()

    await AgentServer(run_processes=False).reconcile()

    assert started == []
    assert await ServiceEndpoint.find_existing(str(deployment.typeid), "chat") is not None


async def test_the_app_does_not_poll_what_a_running_deployment_polls(mail_db, processes):
    running, _started = processes
    agent = await _agent()
    deployment = await agent.run_locally()
    mine = await _channel(agent)
    other_agent = await _agent()
    theirs = await _channel(other_agent)

    assert await polled_by_a_deployment([mine, theirs]) == set(), "no process alive: the app polls both"
    running[str(deployment.id)] = 1
    assert await polled_by_a_deployment([mine, theirs]) == {str(mine.id)}
