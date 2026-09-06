"""The public Python SDK flow for enabling one Agent inbox on the local Hub."""

from __future__ import annotations

import contextlib

import pytest

import flow_sdk
from flow_sdk import LoginRequired
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.builtin.email_inbox import EmailInbox
from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.ingest.drivers.cloud_email import CloudEmailDriver

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(30)]


async def test_agent_enables_email_once():
    await flow_sdk.auth.logout()

    agent = Agent(name=f"inbox-sdk-{mint_uuid()[:8]}")
    await agent.save()
    logged_in = False
    source = None

    try:
        assert agent.inbox is None
        with pytest.raises(LoginRequired):
            await agent.allocate_inbox()
        assert agent.remote is False

        login = await flow_sdk.auth.login()
        logged_in = True
        assert login["status"] == "logged_in"

        inbox = await agent.allocate_inbox()
        assert isinstance(inbox, EmailInbox)
        assert agent.inbox is inbox
        assert inbox.agent_typeid == agent.typeid
        assert inbox.address and "@" in inbox.address
        assert agent.remote is True
        assert inbox.is_active is True
        assert inbox.newly_allocated is True, "the first call allocates the address"

        source = await DataSource.find_for_account(
            CloudEmailDriver.provider,
            CloudEmailDriver.identity_config_key,
            agent.id,
        )
        assert source is not None
        assert source.account_key == inbox.address
        assert source.account_identities == [inbox.address]

        agent.remote = False
        same_inbox = await agent.allocate_inbox()
        assert same_inbox.newly_allocated is False, "asking twice must never bill twice"
        assert agent.remote is True, "a retry must adopt an Agent already published to the Hub"
        assert same_inbox is inbox
        assert same_inbox.typeid == inbox.typeid
        assert same_inbox.provider_inbox_id == inbox.provider_inbox_id
        assert same_inbox.address == inbox.address
        same_source = await DataSource.find_for_account(
            CloudEmailDriver.provider,
            CloudEmailDriver.identity_config_key,
            agent.id,
        )
        assert same_source is not None and same_source.id == source.id

        disabled_inbox = await inbox.disable()
        assert disabled_inbox is not None
        assert disabled_inbox.typeid == inbox.typeid
        assert disabled_inbox.address == inbox.address
        assert disabled_inbox.status == "disabled"
        assert agent.inbox is disabled_inbox
        assert disabled_inbox.is_active is False
        paused_source = await DataSource.find_for_account(
            CloudEmailDriver.provider,
            CloudEmailDriver.identity_config_key,
            agent.id,
        )
        assert paused_source is not None
        assert paused_source.id == source.id
        assert paused_source.status == SourceStatus.DISABLED.value

        resumed_inbox = await agent.allocate_inbox()
        assert resumed_inbox.newly_allocated is False, "re-allocating must adopt, never buy"
        assert resumed_inbox.typeid == inbox.typeid
        assert resumed_inbox.address == inbox.address
        assert resumed_inbox.status == "active"
        resumed_source = await DataSource.find_for_account(
            CloudEmailDriver.provider,
            CloudEmailDriver.identity_config_key,
            agent.id,
        )
        assert resumed_source is not None
        assert resumed_source.id == source.id
        assert resumed_source.status == SourceStatus.ACTIVE.value
    finally:
        try:
            if source is not None:
                await source.delete()
        finally:
            try:
                if logged_in and agent.remote:
                    try:
                        # Release by id, not through the projection under test:
                        # a broken cache must not strand a billable address.
                        # A second DELETE answers 404, so tolerate it.
                        with contextlib.suppress(Exception):
                            await get_email_inbox_driver().delete_inbox(agent.id)
                    finally:
                        await agent.unshare()
            finally:
                try:
                    await agent.delete()
                finally:
                    await flow_sdk.auth.logout()

    assert not is_logged_in()
