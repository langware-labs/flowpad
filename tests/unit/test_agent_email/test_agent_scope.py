"""Agent Inbox scope follows the persisted source relationship, not UI state."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.agent_scope import AgentInboxScopeError, resolve_agent_inbox_scope

pytestmark = pytest.mark.asyncio


async def _source(agent_id: str) -> DataSource:
    source = DataSource(
        name=f"Inbox {agent_id[:8]}",
        provider="cloud_email",
        channel="email",
        config={"agent_id": agent_id, "address": f"{agent_id[:8]}@example.test"},
        account_key=f"{agent_id[:8]}@example.test",
    )
    await source.save()
    return source


async def _message(source: DataSource) -> FlowMessage:
    item = SourceItem(
        name="A message",
        provider="cloud_email",
        kind="content.message.email",
        data_source_id=source.id,
        segment_key="inbox",
        external_id=mint_uuid(),
    )
    await item.save()
    message = FlowMessage(
        text="",
        source_item_id=item.id,
        conversation_id=mint_uuid(),
        thread_id=mint_uuid(),
    )
    await message.save()
    return message


async def test_scope_contains_only_rows_from_the_agents_source(mail_db, monkeypatch):
    agent_id = mint_uuid()
    monkeypatch.setattr(Agent, "get_one", AsyncMock(return_value=Agent(id=agent_id, name="Ada")))
    own_source = await _source(agent_id)
    other_source = await _source(mint_uuid())
    own_message = await _message(own_source)
    other_message = await _message(other_source)

    scope = await resolve_agent_inbox_scope(agent_id)

    assert scope.source_id == own_source.id
    assert scope.flow_message_ids == frozenset({own_message.id})
    assert scope.thread_ids == frozenset({own_message.thread_id})
    assert scope.conversation_ids == frozenset({own_message.conversation_id})
    assert other_message.id not in scope.flow_message_ids


async def test_scope_rejects_invalid_agent_id(mail_db):
    with pytest.raises(AgentInboxScopeError, match="Invalid Agent id") as caught:
        await resolve_agent_inbox_scope("not-an-id")

    assert caught.value.status_code == 400
