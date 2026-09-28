"""An agent's channel is a source it owns — ``create_source(owner=agent)`` + ``save()``, the one way.

A mailbox is *allocated*: the hub mints an address nobody had. A channel already exists, so giving it
to an agent is a source with an owner. Everything downstream — the agent turn, the `agent:<id>`
attribution, the reply — keys on owner, so this is the whole provisioning step.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

CHANNEL = "C08L1P4C95J"


async def _agent(name: str) -> Agent:
    """A distinct name per test — an Agent is a folder asset, so two rows named
    alike collide on the path rather than shadowing each other."""
    agent = Agent(name=name, avatar="💬")
    await agent.save()
    return agent


async def _channel(agent: Agent, **fields) -> DataSource:
    slack = await DataDriver.get("slack")
    source = slack.create_source(slack.create_config(channel=CHANNEL), name=f"{agent.name} on slack", owner=agent, **fields)
    await source.save()
    return source


async def test_the_owner_makes_the_source_the_agents():
    agent = await _agent("channel-owner")

    source = await _channel(agent, allowed_senders=["U1"])

    assert source.owner == agent.typeid, "the owner is the binding; nothing downstream works without it"
    assert source.allowed_senders == ["U1"]


async def test_the_channel_id_is_shaped_by_the_providers_declared_field():
    agent = await _agent("channel-shape")

    source = await _channel(agent)

    stored = (source.config or {}).get("channel")
    assert (stored.get("id") if isinstance(stored, dict) else stored) == CHANNEL, f"unexpected shape {stored!r}"


async def test_a_second_save_adopts_the_same_source():
    """A twin row would double every message in the channel."""
    agent = await _agent("channel-twice")

    first = await _channel(agent)
    second = await _channel(agent, allowed_senders=["U1"])

    assert first.id == second.id and second.allowed_senders == ["U1"]
    mine = await DataSource.get_all({"provider": "slack", "owner": str(agent.typeid)})
    assert len(mine) == 1


async def test_the_allowlist_defaults_to_nobody():
    """A channel is writable by everyone in it — an agent that answers whoever
    speaks is one an unvetted stranger can drive."""
    agent = await _agent("channel-allowlist")

    source = await _channel(agent)

    assert source.allowed_senders == []


async def test_an_owned_channel_names_its_agent_to_every_reader():
    """`agent_id_of` is what the turn, the attribution and the outbound persona
    all ask; the source carries only `owner`."""
    from flow_sdk.stream_inbox.projection import agent_id_of

    agent = await _agent("channel-named")

    source = await _channel(agent)

    assert agent_id_of(source) == str(agent.id)
