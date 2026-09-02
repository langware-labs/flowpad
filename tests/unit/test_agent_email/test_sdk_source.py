"""Agent.enableEmail's local projection converges on one pollable source."""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.email_inbox import EmailInbox
from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver

pytestmark = pytest.mark.asyncio


def _inbox(agent: Agent, address: str = "ada@agentmail.to") -> EmailInbox:
    return EmailInbox.from_hub_descriptor(
        {
            "typeid": f"agent_mailbox-{mint_uuid()}",
            "agent_typeid": str(agent.typeid),
            "address": address,
            "display_name": "Ada",
            "provider": "agentmail",
            "provider_inbox_id": f"inbox-{mint_uuid()}",
            "status": "active",
        },
        agent_typeid=agent.typeid,
    )


async def test_email_source_is_keyed_by_agent_and_created_once(mail_db):
    agent = Agent(name=f"email-source-{mint_uuid()[:8]}")
    inbox = _inbox(agent)

    first = await agent._ensure_email_source(inbox)
    second = await agent._ensure_email_source(inbox)

    assert CloudEmailDriver.identity_config_key == "agent_id"
    assert second.id == first.id
    assert second.config == {
        "agent_id": agent.id,
        "address": inbox.address,
        "inbox_typeid": str(inbox.typeid),
        "provider_inbox_id": inbox.provider_inbox_id,
    }
    assert second.account_key == inbox.address
    assert second.account_identities == [inbox.address]
    assert second.channel == "email"
    assert len(
        [
            source
            for source in await DataSource.get_all({"provider": "cloud_email"})
            if (source.config or {}).get("agent_id") == agent.id
        ]
    ) == 1


async def test_mark_email_enabled_is_idempotent(mail_db, monkeypatch):
    agent = Agent(name=f"email-enable-{mint_uuid()[:8]}")
    saves = 0

    async def save_once(self, *args, **kwargs):
        nonlocal saves
        saves += 1

    monkeypatch.setattr(Agent, "save", save_once)

    await agent._mark_email_enabled()
    await agent._mark_email_enabled()

    assert agent.email_enabled is True
    assert saves == 1


async def test_email_source_reconciles_the_formal_inbox_address(mail_db):
    agent = Agent(name=f"email-source-repair-{mint_uuid()[:8]}")
    old = _inbox(agent, "old@agentmail.to")
    source = await agent._ensure_email_source(old)
    source.account_key = "stale@example.com"
    source.account_identities = ["stale@example.com"]
    source.config = {"agent_id": agent.id, "custom": "preserved"}
    await source.save()

    current = _inbox(agent, "current@agentmail.to")
    repaired = await agent._ensure_email_source(current)

    assert repaired.id == source.id
    assert repaired.account_key == current.address
    assert repaired.account_identities == [current.address]
    assert repaired.config["custom"] == "preserved"
    assert repaired.config["address"] == current.address
    assert repaired.config["inbox_typeid"] == str(current.typeid)
    assert repaired.config["provider_inbox_id"] == current.provider_inbox_id
