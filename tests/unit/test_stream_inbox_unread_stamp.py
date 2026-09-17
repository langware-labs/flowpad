"""The backend stamps each conversation's ``is_unread`` — the one answer rows render.

A projected message arrives unread → its conversation reads unread; reading it clears the
flag. An Agent's unread mail is flagged in the Agent's stream inbox but never lands on the
local user's badge.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.types import EntityType
from flow_sdk.stream_inbox import recompute_unread
from flow_sdk.stream_inbox.projection import project_source_item

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _records_root(tmp_path, monkeypatch):
    monkeypatch.setattr("flow_sdk.fs_store.record_paths.get_default_records_data_root", lambda: tmp_path)


async def _received(owner=None) -> tuple[str, str]:
    """One received, unread message projected into ``owner``'s stream inbox → (fm id, conversation id)."""
    source = DataSource(
        provider="agent", channel="gmail", name=f"mail {uuid.uuid4().hex[:8]}", owner=owner,
        account_key=f"{uuid.uuid4().hex[:8]}@x.test", config={"connector": "gmail", "harness": "claude"},
    )
    await source.save()
    item = SourceItem(
        id=str(uuid.uuid4()), data_source_id=source.id, provider="agent", kind="content.message.email",
        segment_key="INBOX", external_id=f"<{uuid.uuid4().hex[:8]}@x>", name=f"hello {uuid.uuid4().hex[:6]}",
        body="hi", author_external_id="stranger@vendor.test", occurred_at="2026-09-17T10:00:00+00:00",
    )
    await item.save(notify=False)
    fm_id, thread_id = await project_source_item(item, source=source, notify=False, announce=False)
    return fm_id, (await FlowMessage.get_by_id(fm_id)).conversation_id


@pytest.mark.asyncio
async def test_received_mail_reads_unread_until_it_is_read():
    before = (await recompute_unread("test")).unread
    fm_id, conv_id = await _received()

    manager = await recompute_unread("test")
    assert (await Conversation.get_by_id(conv_id)).is_unread is True
    assert manager.unread == before + 1

    fm = await FlowMessage.get_by_id(fm_id)
    fm.is_read = True
    await fm.save(notify=False)
    manager = await recompute_unread("test")
    assert (await Conversation.get_by_id(conv_id)).is_unread is False
    assert manager.unread == before


@pytest.mark.asyncio
async def test_an_agents_unread_mail_stays_off_the_users_badge():
    agent = Agent(name=f"mailer-{uuid.uuid4().hex[:6]}")
    await agent.save()
    before = (await recompute_unread("test")).unread

    _, conv_id = await _received(owner=TypeId(type=EntityType.AGENT.value, id=agent.id))
    manager = await recompute_unread("test")

    assert (await Conversation.get_by_id(conv_id)).is_unread is True, "flagged where the agent's stream inbox renders it"
    assert manager.unread == before, "an agent's mail is its own stream inbox, not the user's badge"


@pytest.mark.asyncio
async def test_mark_all_read_in_the_users_stream_inbox_leaves_an_agents_mail_unread():
    """A bulk verb is bounded by the stream inbox it was clicked in, not by the machine."""
    from flow_sdk.app.actions.flow_message_action import _bulk_stream_inbox_scope, handle_stream_inbox_bulk_update

    agent = Agent(name=f"mailer-{uuid.uuid4().hex[:6]}")
    await agent.save()
    mine, _ = await _received()
    theirs, _ = await _received(owner=TypeId(type=EntityType.AGENT.value, id=agent.id))

    scope = await _bulk_stream_inbox_scope(None)
    await handle_stream_inbox_bulk_update({"is_read": True}, None, allowed_flow_message_ids=scope.flow_message_ids)

    assert (await FlowMessage.get_by_id(mine)).is_read is True
    assert (await FlowMessage.get_by_id(theirs)).is_read is False, "the user's 'mark all read' must not read an agent's mail"
