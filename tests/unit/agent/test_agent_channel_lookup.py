"""An agent finds its own channels by kind, and an agent by name — or says why not.

``Agent.channel(kind)`` never picks between two: two WhatsApp numbers is the caller's choice, made
over ``channels()``. ``Agent.by_name`` raises on a miss, because a script that names an agent means
that one. ``docs/snippets/agent-deployment.md`` §6 is built on both.
"""
import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import SourceStatus
from flow_sdk.ingest.testing import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval


async def _agent() -> Agent:
    agent = Agent(name=f"lookup-{uuid.uuid4().hex[:6]}", worker_type="claude")
    await agent.save()
    return agent


async def _owned(agent: Agent, provider: str, **config):
    source = make_data_source(
        provider, name=f"{provider} {uuid.uuid4().hex[:6]}", config=config, owner=agent.typeid,
        status=SourceStatus.ACTIVE.value,
    )
    await source.save()
    return source


async def test_one_channel_of_a_kind_is_found():
    agent = await _agent()
    chat = await _owned(agent, "telegram", base_url="http://127.0.0.1:9")

    assert (await agent.channel("telegram")).id == chat.id
    assert [s.id for s in await agent.channels()] == [chat.id]


async def test_none_or_two_of_a_kind_is_refused_not_picked():
    agent = await _agent()
    with pytest.raises(LookupError, match="0 'telegram' channels"):
        await agent.channel("telegram")

    await _owned(agent, "telegram", base_url="http://127.0.0.1:9")
    await _owned(agent, "telegram", base_url="http://127.0.0.1:8")
    with pytest.raises(LookupError, match="2 'telegram' channels"):
        await agent.channel("telegram")
    assert len(await agent.channels()) == 2


async def test_a_source_that_cannot_send_is_not_a_channel():
    agent = await _agent()
    await _owned(agent, "rss", feed_url="http://127.0.0.1:9/feed.xml")

    assert await agent.channels() == []


async def test_by_name_finds_the_agent_and_refuses_a_stranger():
    agent = await _agent()

    assert (await Agent.by_name(agent.name)).id == agent.id
    with pytest.raises(LookupError, match="no agent named 'nobody-here'"):
        await Agent.by_name("nobody-here")
