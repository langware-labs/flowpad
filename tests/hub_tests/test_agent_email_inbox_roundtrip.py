"""The public Python SDK flow for enabling one Agent inbox on the local Hub."""

from __future__ import annotations

import pytest

import flow_sdk
from flow_sdk import LoginRequired
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.email_inbox import EmailInbox
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
            await agent.enableEmail()
        assert agent.remote is False

        login = await flow_sdk.auth.login()
        logged_in = True
        assert login["status"] == "logged_in"

        inbox = await agent.enableEmail()
        assert isinstance(inbox, EmailInbox)
        assert agent.inbox is inbox
        assert inbox.agent_typeid == agent.typeid
        assert inbox.address and "@" in inbox.address
        assert agent.remote is True
        assert agent.email_enabled is True

        source = await DataSource.find_for_account(
            CloudEmailDriver.provider,
            CloudEmailDriver.identity_config_key,
            agent.id,
        )
        assert source is not None
        assert source.account_key == inbox.address
        assert source.account_identities == [inbox.address]

        same_inbox = await agent.enableEmail()
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
    finally:
        try:
            if source is not None:
                await source.delete()
        finally:
            try:
                if logged_in and agent.remote:
                    try:
                        await agent.decommission_inbox()
                    finally:
                        await agent.unshare()
            finally:
                try:
                    await agent.delete()
                finally:
                    await flow_sdk.auth.logout()

    assert not is_logged_in()
