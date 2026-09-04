"""Binding a channel to an agent — the sibling of allocating a mailbox.

A mailbox is *allocated*: the hub mints an address nobody had. A channel already
exists and someone already connected the provider, so binding is a lookup plus an
owner. Everything downstream — the agent turn, the `agent:<id>` attribution, the
reply — already keys on owner, so this is the whole provisioning step.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]

CHANNEL = "C08L1P4C95J"


@pytest.fixture
def connected(monkeypatch):
    """Slack, held. `bind_channel` refuses before it mints a row otherwise —
    see `test_an_unconnected_provider_is_refused_before_a_row_exists`."""
    async def _held(provider):
        return SimpleNamespace(provider=provider, connected=True)

    monkeypatch.setattr("flow_sdk.connections.require", _held)


async def _agent(name: str) -> Agent:
    """A distinct name per test — an Agent is a folder asset, so two rows named
    alike collide on the path rather than shadowing each other."""
    agent = Agent(name=name, avatar="💬")
    await agent.save()
    return agent


async def test_binding_makes_the_source_the_agents(connected):
    agent = await _agent("binder-owner")

    source = await agent.bind_channel(provider="slack", channel=CHANNEL, allowed_senders=["U1"])

    assert source.owner == agent.typeid, "the binding is the owner; nothing downstream works without it"
    assert source.inbound_allowed_senders == ["U1"]


async def test_the_channel_id_is_shaped_by_the_providers_declared_field(connected):
    """`channels` is declared `lines`, so a bare id must land as a list.

    `bind_channel` writes the bare value on purpose and lets `_coerce_config`
    apply the provider's own field type on save — otherwise this method would
    need to know which providers take lists.
    """
    agent = await _agent("binder-shape")

    source = await agent.bind_channel(provider="slack", channel=CHANNEL)

    stored = (source.config or {}).get("channels")
    assert stored in (CHANNEL, [CHANNEL]), f"unexpected shape {stored!r}"


async def test_binding_twice_adopts_the_same_source(connected):
    """A twin row would double every message in the channel."""
    agent = await _agent("binder-twice")

    first = await agent.bind_channel(provider="slack", channel=CHANNEL)
    second = await agent.bind_channel(provider="slack", channel=CHANNEL, allowed_senders=["U1"])

    assert first.id == second.id
    # Scoped to this agent: the module's other tests bind the same channel, and
    # a count over every slack row would measure them instead.
    mine = await DataSource.get_all({"provider": "slack", "owner": str(agent.typeid)})
    assert len(mine) == 1


async def test_the_allowlist_defaults_to_nobody(connected):
    """A channel is writable by everyone in it — an agent that answers whoever
    speaks is one an unvetted stranger can drive."""
    agent = await _agent("binder-allowlist")

    source = await agent.bind_channel(provider="slack", channel=CHANNEL)

    assert source.inbound_allowed_senders == []


async def test_a_one_way_provider_is_refused(monkeypatch):
    """Reading it is fine; an agent bound to it could never answer."""
    monkeypatch.setattr(
        "flow_sdk.ingest.driver.get_driver",
        lambda _p: SimpleNamespace(sends=False, identity_config_key="feeds", kind="datasource.api.rss"),
    )
    agent = await _agent("binder-oneway")

    with pytest.raises(ValueError, match="cannot send"):
        await agent.bind_channel(provider="rss", channel="feed")


async def test_a_bound_channel_names_its_agent_to_every_reader(connected):
    """`agent_id_of` is what the turn, the attribution and the outbound persona
    all ask. A binding writes only `owner`, so if that reader did not honour it
    the channel would ingest and then answer as nobody."""
    from flow_sdk.inbox.projection import agent_id_of

    agent = await _agent("binder-named")

    source = await agent.bind_channel(provider="slack", channel=CHANNEL)

    assert agent_id_of(source) == str(agent.id)


async def test_an_unconnected_provider_is_refused_before_a_row_exists(monkeypatch):
    """The precheck `Inbox.ensure_source` carries: a source minted without a
    connection looks bound and then parks on its first poll, so the honest
    failure is at the binding, naming the fix."""
    from flow_sdk.connections import NotConnected

    async def _absent(provider):
        raise NotConnected(provider)

    monkeypatch.setattr("flow_sdk.connections.require", _absent)
    agent = await _agent("binder-unconnected")

    with pytest.raises(NotConnected):
        await agent.bind_channel(provider="slack", channel=CHANNEL)

    assert await DataSource.get_all({"provider": "slack", "owner": str(agent.typeid)}) == []
