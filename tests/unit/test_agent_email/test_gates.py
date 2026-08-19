"""Who may drive an agent by mail, and what must never drive it.

Every test here asserts a REFUSAL reaches its answer without touching the
process machinery. That is the property worth pinning: the gates are what stand
between a public, permanent address and an agent holding tools, so they have to
decide before anything expensive — or dangerous — happens.
"""
from __future__ import annotations

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.agent_runner import _is_own_outgoing, handle_inbound

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

MAILBOX = "ada@agentmail.to"


def _unsaved(**kw) -> Agent:
    """`may_email` is pure — these cases need no row and no asset on disk."""
    return Agent(name="Ada", **kw)


async def _agent(name: str, **kw) -> Agent:
    """A SAVED agent. Named per test: an Agent is a file-backed asset, so two
    agents sharing a name collide on the asset path rather than on the row."""
    agent = Agent(name=name, **kw)
    await agent.save()
    return agent


async def _source(agent_id: str) -> DataSource:
    source = DataSource(
        name="Ada's mailbox",
        provider="cloud_email",
        channel="email",
        config={"agent_id": agent_id, "address": MAILBOX},
        account_key=MAILBOX,
    )
    await source.save()
    return source


def _item(source_id: str, sender: str, body: str = "what is the status?") -> SourceItem:
    return SourceItem(
        data_source_id=source_id,
        provider="cloud_email",
        segment_key="agent-1",
        external_id="<msg-1@x>",
        name="Status?",
        body=body,
        author_external_id=sender,
    )


# ── the allowlist ─────────────────────────────────────────────────────────────


async def test_closed_by_default():
    """An agent nobody configured must not be drivable.

    The address is public, permanent and publicly writable. A default that
    admitted anyone would hand an agent with tools to whoever guessed it.
    """
    assert _unsaved().may_email("stranger@x.com") is False


async def test_enabled_but_empty_list_still_refuses():
    """Enabling email is not the same as allowing everyone."""
    assert _unsaved(email_enabled=True).may_email("stranger@x.com") is False


async def test_listed_sender_is_admitted_case_and_space_insensitively():
    """An address is something a human types, not a byte string."""
    agent = _unsaved(email_enabled=True, email_allowed_senders=["Alice@Example.com"])
    assert agent.may_email("  alice@example.com ") is True


async def test_disabling_email_overrides_the_list():
    """The switch is a kill switch — it must beat a populated allowlist."""
    agent = _unsaved(email_enabled=False, email_allowed_senders=["alice@example.com"])
    assert agent.may_email("alice@example.com") is False


# ── the loop guard ────────────────────────────────────────────────────────────


async def test_our_own_outgoing_copy_is_recognised(mail_db):
    """The hub files a sent copy in the same mailbox, so the next poll ingests
    the agent's OWN reply. Answering it would loop forever."""
    agent = await _agent("ada-own-copy", email_enabled=True, email_allowed_senders=[MAILBOX])
    source = await _source(agent.id)

    assert _is_own_outgoing(_item(source.id, MAILBOX), source) is True
    assert _is_own_outgoing(_item(source.id, "alice@example.com"), source) is False


async def test_own_outgoing_does_not_run_even_when_self_is_allowlisted(mail_db):
    """Belt and braces. The allowlist alone would stop the loop — an agent's
    address is not normally a permitted sender — but "not normally" is not a
    mechanism, and the failure mode is an agent talking to itself forever.
    """
    agent = await _agent("ada-self-loop", email_enabled=True, email_allowed_senders=[MAILBOX])
    source = await _source(agent.id)

    assert await handle_inbound(_item(source.id, MAILBOX)) is False


# ── handle_inbound short-circuits ────────────────────────────────────────────


async def test_unlisted_sender_runs_nothing(mail_db):
    agent = await _agent("ada-unlisted", email_enabled=True, email_allowed_senders=["alice@example.com"])
    source = await _source(agent.id)

    assert await handle_inbound(_item(source.id, "stranger@x.com")) is False


async def test_a_source_that_is_not_an_agents_mailbox_is_ignored(mail_db):
    """An ordinary mailbox belongs to a person; nothing should answer for them."""
    source = DataSource(name="my mail", provider="cloud_email", channel="email", config={})
    await source.save()

    assert await handle_inbound(_item(source.id, "alice@example.com")) is False


async def test_an_empty_body_runs_nothing(mail_db):
    """A read receipt or an empty forward is not a question."""
    agent = await _agent("ada-empty", email_enabled=True, email_allowed_senders=["alice@example.com"])
    source = await _source(agent.id)

    assert await handle_inbound(_item(source.id, "alice@example.com", body="   ")) is False
