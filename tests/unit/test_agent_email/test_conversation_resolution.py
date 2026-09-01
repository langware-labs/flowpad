"""Which conversation does an inbound message belong to?

The runner pins one agent process per conversation, so this answer decides
whether a reply continues the thread or starts a stranger. It has one trap: the
projection MINTS a conversation id from the thread key, but that is a birth
default only — once a thread exists its `conversation_id` is authoritative,
because merging two threads repoints it. Re-deriving instead of reading would
answer with the pre-merge id and silently split the session in half.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.agent_runner import _conversation_id_for
from flow_sdk.inbox.projection import channel_of, thread_key_for

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _source() -> DataSource:
    source = DataSource(
        name="mailbox",
        provider="cloud_email",
        channel="email",
        config={"agent_id": "agent-1", "address": "ada@agentmail.to"},
    )
    await source.save()
    return source


def _item(source_id: str, thread_key: str) -> SourceItem:
    return SourceItem(
        data_source_id=source_id,
        provider="cloud_email",
        segment_key="agent-1",
        external_id="<m1@x>",
        name="Subject",
        body="hello",
        author_external_id="alice@example.com",
        thread_key=thread_key,
    )


async def _thread_for(source, item, *, conversation_id: str) -> MessageThread:
    thread = MessageThread(
        # An ordinary uuid4: identity is the (channel, thread_key) lookup now,
        # which is exactly what `_conversation_id_for` resolves by.
        id=str(uuid.uuid4()),
        channel=channel_of(source),
        thread_key=thread_key_for(item, item.name or ""),
        conversation_id=conversation_id,
        title="Subject",
        name="Subject",
    )
    await thread.save()
    return thread


async def test_it_reads_the_threads_conversation(mail_db):
    source = await _source()
    item = _item(source.id, "agent-1:t-1")
    await _thread_for(source, item, conversation_id="conv-original")

    assert await _conversation_id_for(item, source) == "conv-original"


async def test_a_repointed_thread_wins_over_the_derived_id(mail_db):
    """The trap. A merged thread points at the SURVIVING conversation; deriving
    from the key would still answer with the one it was born with."""
    source = await _source()
    item = _item(source.id, "agent-1:t-1")
    thread = await _thread_for(source, item, conversation_id="conv-original")

    thread.conversation_id = "conv-after-merge"
    await thread.save()

    assert await _conversation_id_for(item, source) == "conv-after-merge"


async def test_no_thread_yet_means_no_conversation(mail_db):
    """Better to answer nothing than to invent an id the projection never used —
    a fabricated conversation would pin a process nothing else can find."""
    source = await _source()

    assert await _conversation_id_for(_item(source.id, "agent-1:t-unseen"), source) is None


async def test_two_agents_resolve_to_different_conversations(mail_db):
    """The scoping fix, asserted where it actually matters: not that the keys
    differ, but that two agents end up in two conversations — and therefore two
    processes, with two contexts."""
    source_a = await _source()
    source_b = DataSource(
        name="mailbox b",
        provider="cloud_email",
        channel="email",
        config={"agent_id": "agent-2", "address": "bob@agentmail.to"},
    )
    await source_b.save()

    item_a = _item(source_a.id, "agent-1:shared-provider-id")
    item_b = _item(source_b.id, "agent-2:shared-provider-id")
    await _thread_for(source_a, item_a, conversation_id="conv-a")
    await _thread_for(source_b, item_b, conversation_id="conv-b")

    assert await _conversation_id_for(item_a, source_a) == "conv-a"
    assert await _conversation_id_for(item_b, source_b) == "conv-b"
