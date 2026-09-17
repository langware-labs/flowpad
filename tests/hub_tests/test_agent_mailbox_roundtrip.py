"""The public Python SDK flow for enabling one Agent mailbox on the local Hub."""

from __future__ import annotations

import contextlib

import pytest

import flow_sdk
from flow_sdk import LoginRequired
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_mailbox import AgentMailbox
from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.cli.auth.hub_login import is_logged_in
from flow_sdk.ingest.driver_registry import asset_module

CloudEmailSource = asset_module("cloud_email").CloudEmailSource

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(30)]


async def test_agent_enables_email_once():
    await flow_sdk.auth.logout()

    agent = Agent(name=f"mailbox-sdk-{mint_uuid()[:8]}")
    await agent.save()
    logged_in = False
    source = None

    try:
        assert agent.mailbox is None
        with pytest.raises(LoginRequired):
            await agent.allocate_mailbox()
        assert agent.remote is False

        login = await flow_sdk.auth.login()
        logged_in = True
        assert login["status"] == "logged_in"

        mailbox = await agent.allocate_mailbox()
        assert isinstance(mailbox, AgentMailbox)
        assert agent.mailbox is mailbox
        assert mailbox.agent_typeid == agent.typeid
        assert mailbox.address and "@" in mailbox.address
        assert agent.remote is True
        assert mailbox.is_active is True
        assert mailbox.newly_allocated is True, "the first call allocates the address"

        source = await DataSource.find_for_account(
            CloudEmailSource.provider,
            CloudEmailSource.identity_config_key,
            agent.id,
        )
        assert source is not None
        assert source.account_key == mailbox.address
        assert source.account_identities == [mailbox.address]

        agent.remote = False
        same_mailbox = await agent.allocate_mailbox()
        assert same_mailbox.newly_allocated is False, "asking twice must never bill twice"
        assert agent.remote is True, "a retry must adopt an Agent already published to the Hub"
        assert same_mailbox is mailbox
        assert same_mailbox.typeid == mailbox.typeid
        assert same_mailbox.provider_inbox_id == mailbox.provider_inbox_id
        assert same_mailbox.address == mailbox.address
        same_source = await DataSource.find_for_account(
            CloudEmailSource.provider,
            CloudEmailSource.identity_config_key,
            agent.id,
        )
        assert same_source is not None and same_source.id == source.id

        disabled_mailbox = await mailbox.disable()
        assert disabled_mailbox is not None
        assert disabled_mailbox.typeid == mailbox.typeid
        assert disabled_mailbox.address == mailbox.address
        assert disabled_mailbox.status == "disabled"
        assert agent.mailbox is disabled_mailbox
        assert disabled_mailbox.is_active is False
        paused_source = await DataSource.find_for_account(
            CloudEmailSource.provider,
            CloudEmailSource.identity_config_key,
            agent.id,
        )
        assert paused_source is not None
        assert paused_source.id == source.id
        assert paused_source.status == SourceStatus.DISABLED.value

        resumed_mailbox = await agent.allocate_mailbox()
        assert resumed_mailbox.newly_allocated is False, "re-allocating must adopt, never buy"
        assert resumed_mailbox.typeid == mailbox.typeid
        assert resumed_mailbox.address == mailbox.address
        assert resumed_mailbox.status == "active"
        resumed_source = await DataSource.find_for_account(
            CloudEmailSource.provider,
            CloudEmailSource.identity_config_key,
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
                            await get_agent_mailbox_driver().delete_mailbox(agent.id)
                    finally:
                        await agent.unshare()
            finally:
                try:
                    await agent.delete()
                finally:
                    await flow_sdk.auth.logout()

    assert not is_logged_in()
