"""Who may drive an agent by mail, and what must never drive it.

Every test here asserts a REFUSAL reaches its answer without touching the
process machinery. That is the property worth pinning: the gates are what stand
between a public, permanent address and an agent holding tools, so they have to
decide before anything expensive — or dangerous — happens.

The file splits deliberately. The policy cases below build an ``AgentMailbox``
directly and stay PURE — no row, no asset, no network — because
``mailbox.allowed()`` runs on every inbound message and must never reach the Hub.
The rest drive the serve loop's per-message ``answer`` on an engine that
must not be reached, and pin behaviour rather than shape.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_mailbox import STATUS_ACTIVE, STATUS_DISABLED, AgentMailbox
from flow_sdk.builtin.agent_serve import TurnEngine, answer, answered_sources, is_own_outgoing
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.fs_store.type_id import TypeId

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MAILBOX = "ada@agentmail.to"


def _mailbox(*, status: str = STATUS_ACTIVE, allowed: list[str] | None = None) -> AgentMailbox:
    """A mailbox projection. ``allowed()`` is pure, so this needs no row."""
    return AgentMailbox(
        address=MAILBOX,
        provider="agentmail",
        provider_inbox_id="mbx-1",
        status=status,
        agent_typeid=TypeId(type="agent", id="00000000-0000-4000-8000-00000000abcd"),
        allowed_senders=list(allowed or []),
    )


async def _agent(name: str, **kw) -> Agent:
    """A SAVED agent. Named per test: an Agent is a file-backed asset, so two
    agents sharing a name collide on the asset path rather than on the row."""
    agent = Agent(name=name, **kw)
    await agent.save()
    return agent


async def _source(agent_id: str, allowed: list[str] | None = None) -> DataSource:
    """The mailbox's local row. It carries the cached allowlist the gate reads."""
    source = DataSource(
        name="Ada's mailbox",
        provider="cloud_email",
        channel="email",
        config={
            "agent_id": agent_id,
            "address": MAILBOX,
            "provider_inbox_id": "mbx-1",
        },
        account_key=MAILBOX,
        status=SourceStatus.ACTIVE.value,
        inbound_allowed_senders=list(allowed or []),
    )
    await source.save()
    return source


def _item(source_id: str, sender: str, body: str = "what is the status?") -> SourceItem:
    return SourceItem(
        data_source_id=source_id,
        provider="cloud_email",
        external_id="<msg-1@x>",
        name="Status?",
        body=body,
        author_external_id=sender,
    )


# ── the allowlist ─────────────────────────────────────────────────────────────


async def test_closed_by_default():
    """A mailbox nobody configured must not be drivable.

    The address is public, permanent and publicly writable. A default that
    admitted anyone would hand an agent with tools to whoever guessed it.
    """
    assert _mailbox().allowed("stranger@x.com") is False


async def test_an_empty_list_still_refuses():
    """Having a mailbox is not the same as allowing everyone."""
    assert _mailbox(allowed=[]).allowed("stranger@x.com") is False


async def test_listed_sender_is_admitted_case_and_space_insensitively():
    """An address is something a human types, not a byte string."""
    assert _mailbox(allowed=["Alice@Example.com"]).allowed("  alice@example.com ") is True


# ── from_source on a bind_channel-bound source (owner, no config.agent_id) ────


async def test_from_source_resolves_the_agent_from_owner_when_config_has_no_agent_id():
    """A channel `Agent.bind_channel` bound (Slack, Teams, …) carries no
    `config.agent_id` at all — that key belongs to the cloud-mailbox
    (`allocate_mailbox`) driver only. Its agent is the `owner`.

    Before the fix, `from_source` read only `config.get("agent_id")`, got
    `""`, and `TypeId(type="agent", id="")` raised — crashing the inbound
    answer path for every single bind_channel-bound source, always, silently
    (swallowed by the handler's catch-all). `agent_id_of` is the
    already-existing reader that falls back to `owner`; `from_source` now
    goes through it instead of re-spelling half the rule.
    """
    agent_id = "5be3d54a-3e27-4a92-bef9-cbb723e71871"
    source = DataSource(
        name="slack-q-agent",
        provider="slack",
        channel="slack",
        config={"channel": {"id": "C0123456789", "name": "test"}},  # no agent_id key
        owner=TypeId(type="agent", id=agent_id),
        status=SourceStatus.ACTIVE.value,
        inbound_allowed_senders=["U0BP53L7Z5G"],
    )

    mailbox = AgentMailbox.from_source(source)  # must not raise

    assert mailbox.agent_typeid == TypeId(type="agent", id=agent_id)
    assert mailbox.allowed("U0BP53L7Z5G") is True


async def test_a_disabled_mailbox_overrides_the_list():
    """The switch is a kill switch — it must beat a populated allowlist."""
    mailbox = _mailbox(status=STATUS_DISABLED, allowed=["alice@example.com"])
    assert mailbox.is_active is False
    assert mailbox.allowed("alice@example.com") is False


# ── the loop guard ────────────────────────────────────────────────────────────


async def test_our_own_outgoing_copy_is_recognised(mail_db):
    """The hub files a sent copy in the same mailbox, so the next poll ingests
    the agent's OWN reply. Answering it would loop forever."""
    agent = await _agent("ada-own-copy")
    source = await _source(agent.id, [MAILBOX])

    assert is_own_outgoing(source, MAILBOX) is True
    assert is_own_outgoing(source, "alice@example.com") is False


async def test_own_outgoing_does_not_run_even_when_self_is_allowlisted(mail_db):
    """Belt and braces. The allowlist alone would stop the loop — an agent's
    address is not normally a permitted sender — but "not normally" is not a
    mechanism, and the failure mode is an agent talking to itself forever.
    """
    agent = await _agent("ada-self-loop")
    source = await _source(agent.id, [MAILBOX])

    assert await _refused(agent, source, _item(source.id, MAILBOX))


# ── answer short-circuits ────────────────────────────────────────────────────


async def test_unlisted_sender_runs_nothing(mail_db):
    agent = await _agent("ada-unlisted")
    source = await _source(agent.id, ["alice@example.com"])

    assert await _refused(agent, source, _item(source.id, "stranger@x.com"))


async def test_a_disabled_source_runs_nothing(mail_db):
    """Pausing the mailbox stops mail driving the agent, without releasing it."""
    agent = await _agent("ada-paused")
    source = await _source(agent.id, ["alice@example.com"])
    source.status = SourceStatus.DISABLED.value
    await source.save()

    assert await _refused(agent, source, _item(source.id, "alice@example.com"))


async def test_a_listed_sender_passes_the_gate(mail_db):
    """The counterweight to every refusal above: a gate that refused everyone —
    an unseeded cache, say — would pass all of them and prove nothing."""
    agent = await _agent("ada-admitted")
    source = await _source(agent.id, ["alice@example.com"])

    mailbox = AgentMailbox.from_source(source)
    assert mailbox.allowed("alice@example.com") is True
    assert mailbox.allowed("stranger@x.com") is False


async def test_a_source_that_is_not_an_agents_mailbox_is_ignored(mail_db):
    """An ordinary mailbox belongs to a person; nothing should answer for them —
    it is never among the sources an agent's placement serves."""
    agent = await _agent("ada-not-mine")
    source = DataSource(name="my mail", provider="cloud_email", channel="email", config={})
    await source.save()

    served = await answered_sources(agent, await agent.local_deployment())
    assert str(source.id) not in {str(s.id) for s in served}


async def test_an_empty_body_runs_nothing(mail_db):
    """A read receipt or an empty forward is not a question."""
    agent = await _agent("ada-empty")
    source = await _source(agent.id, ["alice@example.com"])

    assert await _refused(agent, source, _item(source.id, "alice@example.com", body="   "))


async def _refused(agent, source, item) -> bool:
    """``answer`` refused *item* — without ever asking for a process."""

    async def no_process(*_a, **_k):
        raise AssertionError("a refused message reached the process machinery")

    engine = TurnEngine(agent, None)
    engine.process_for = no_process
    return await answer(engine, source, item) is False
