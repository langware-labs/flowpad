"""The mailbox's local projection converges on one pollable source.

``ensure_source`` is the inbox's own verb: the Hub owns the address, and this is
the row that polls it. It has to be idempotent (a caller retries) and it has to
repair a source whose address moved, because re-provisioning mints a new address
for the same agent and the old row would otherwise keep polling nothing.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource, SourceStatus
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

    first = await inbox.ensure_source()
    second = await inbox.ensure_source()

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


async def test_re_wiring_an_active_mailbox_writes_no_second_row(mail_db):
    """Wiring is idempotent, and re-wiring re-activates rather than duplicating.

    Replaces the old `_mark_email_enabled` idempotence test: `email_enabled` is
    gone (the Hub's status and the source's status are the only two truths), so
    the property that still matters is the one about rows.
    """
    agent = Agent(name=f"email-rewire-{mint_uuid()[:8]}")
    inbox = _inbox(agent)

    first = await inbox.ensure_source()
    first.status = SourceStatus.DISABLED.value
    await first.save()

    second = await inbox.ensure_source()

    assert second.id == first.id
    assert second.status == SourceStatus.ACTIVE.value, "re-wiring must resume polling"


async def test_email_source_reconciles_the_formal_inbox_address(mail_db):
    agent = Agent(name=f"email-source-repair-{mint_uuid()[:8]}")
    old = _inbox(agent, "old@agentmail.to")
    source = await old.ensure_source()
    source.account_key = "stale@example.com"
    source.account_identities = ["stale@example.com"]
    source.config = {"agent_id": agent.id, "custom": "preserved"}
    await source.save()

    current = _inbox(agent, "current@agentmail.to")
    repaired = await current.ensure_source()

    assert repaired.id == source.id
    assert repaired.account_key == current.address
    assert repaired.account_identities == [current.address]
    assert repaired.config["custom"] == "preserved"
    assert repaired.config["address"] == current.address
    assert repaired.config["inbox_typeid"] == str(current.typeid)
    assert repaired.config["provider_inbox_id"] == current.provider_inbox_id


async def test_unpublished_agent_resolves_to_no_inbox_without_calling_hub(mail_db, monkeypatch):
    import flow_sdk.builtin.email_inbox_driver as inbox_driver

    agent = Agent(name=f"email-local-{mint_uuid()[:8]}")

    def unexpected_driver():
        raise AssertionError("an unpublished Agent has no Hub inbox to resolve")

    monkeypatch.setattr(inbox_driver, "get_email_inbox_driver", unexpected_driver)

    assert agent.remote is False
    assert await EmailInbox.for_agent(agent) is None
    assert agent.inbox is None
