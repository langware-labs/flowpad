"""The loop a running local deployment's process runs (``builtin/agent_loop``) keeps itself running.

It follows its channels (one added restarts the loop over both), survives a loop that fails
(started again), and ends when the deployment does. :func:`serve` is faked to record what it was
given; the timings are shortened so each case is a few recheck cycles.
"""
from __future__ import annotations

import asyncio
import uuid

import pytest

import flow_sdk.builtin.agent_loop as agent_loop
import flow_sdk.builtin.agent_serve as agent_serve
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(agent_loop, "RECHECK_SECONDS", 0.05)
    monkeypatch.setattr(agent_loop, "RESTART_SECONDS", 0.01)


@pytest.fixture
def served(monkeypatch):
    """What each start of the loop served; ``fail`` makes the next start raise."""
    runs: list[set[str]] = []
    fail = {"next": False}

    async def serve(agent, deployment, *, sources=None, poll_every=None, loop=None):
        runs.append({str(s.id) for s in sources})
        if fail["next"]:
            fail["next"] = False
            raise RuntimeError("the loop broke")
        await asyncio.Event().wait()

    monkeypatch.setattr(agent_serve, "serve", serve)
    return runs, fail


async def _channel(agent: Agent) -> DataSource:
    channel_id = f"C{uuid.uuid4().hex[:10].upper()}"
    source = DataSource(name=f"slack {channel_id}", provider="slack", channel="slack",
                        config={"channel": {"id": channel_id, "name": channel_id.lower()}}, owner=agent.typeid)
    await source.save()
    return source


async def _until(predicate) -> None:
    while not predicate():
        await asyncio.sleep(0.01)


async def test_the_loop_follows_its_channels_survives_a_failure_and_ends_with_its_deployment(mail_db, served):
    runs, fail = served
    agent = Agent(name=f"looped-{uuid.uuid4().hex[:8]}", worker_type="claude")
    await agent.save()
    deployment = await agent.run_locally()
    chat = (await agent_serve.answered_sources(agent, deployment))[0]
    task = asyncio.create_task(agent_loop.run(deployment.id))

    await _until(lambda: runs)
    assert runs[-1] == {str(chat.id)}

    slack = await _channel(agent)
    await _until(lambda: len(runs) >= 2)
    assert runs[-1] == {str(chat.id), str(slack.id)}, "a channel added is served"

    fail["next"] = True
    slack.status = "disabled"  # also a change: the next start is over the same set, and fails
    await slack.save()
    await _until(lambda: len(runs) >= 4)
    assert not task.done(), "a loop that failed is started again, not the end of the process"

    deployment.serving = False
    await deployment.save()
    await asyncio.wait_for(task, timeout=2)  # the deployment stopped: the process's loop ends
