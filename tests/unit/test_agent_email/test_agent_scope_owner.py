"""The Agent inbox scope is a filter on ``owner`` and answers exactly as the walk did.

One instance, two owners: the local user's Gmail source and an Agent's cloud
mailbox. The Agent's scope must contain its rows and none of the user's; the
user's rows must not acquire the Agent as owner; and a source that carries only
the legacy ``config.agent_id`` (no ``owner`` column yet) must still be found.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.inbox.agent_scope import is_message_source, resolve_agent_inbox_scope
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.asyncio


async def _source(provider: str, channel: str, **config) -> DataSource:
    source = DataSource(name=f"{provider} src", provider=provider, channel=channel, config=config)
    await source.save()
    return source


async def _message(source: DataSource) -> FlowMessage:
    item = SourceItem(
        name="m", provider=source.provider, kind="content.message.email",
        data_source_id=source.id, segment_key="inbox", external_id=mint_uuid(),
    )
    await item.save()
    message = FlowMessage(text="", source_item_id=item.id, conversation_id=mint_uuid(), thread_id=mint_uuid())
    await message.save()
    return message


async def test_agent_scope_is_its_owned_rows_and_none_of_the_users(mail_db, monkeypatch):
    agent_id = mint_uuid()
    monkeypatch.setattr(Agent, "get_one", AsyncMock(return_value=Agent(id=agent_id, name="Ada")))
    agent_tid = TypeId(type=EntityType.AGENT.value, id=agent_id)

    # Legacy-shaped agent source: config.agent_id only. `save` resolves the owner from it.
    agents = await _source("cloud_email", "email", agent_id=agent_id, address="ada@example.test")
    assert agents.owner == agent_tid
    users = await _source("gmail", "gmail", address="me@gmail.com")
    # `mail_db` has no local-user row, so the user's source may stay unowned here;
    # what matters is that it never resolves to the agent.
    assert users.owner != agent_tid, "the user's source must not become the agent's"

    mine = await _message(agents)
    theirs = await _message(users)

    scope = await resolve_agent_inbox_scope(agent_id)
    assert scope.source_id == agents.id
    assert scope.source_ids == frozenset({agents.id})
    assert scope.flow_message_ids == frozenset({mine.id})
    assert mine.thread_id in scope.thread_ids and mine.conversation_id in scope.conversation_ids
    assert theirs.id not in scope.flow_message_ids
    assert theirs.thread_id not in scope.thread_ids
    assert theirs.conversation_id not in scope.conversation_ids
    assert "source_ids" in scope.as_dict()


async def test_only_message_sources_count_toward_the_scope(mail_db, monkeypatch):
    agent_id = mint_uuid()
    monkeypatch.setattr(Agent, "get_one", AsyncMock(return_value=Agent(id=agent_id, name="Ada")))
    agent_tid = TypeId(type=EntityType.AGENT.value, id=agent_id)

    feed = DataSource(name="rss", provider="rss", channel="", owner=agent_tid)
    await feed.save()
    assert not is_message_source(feed), "no channel → not a message source"
    scope = await resolve_agent_inbox_scope(agent_id)
    assert scope.source_id is None and scope.source_ids == frozenset()
