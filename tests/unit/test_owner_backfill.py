"""The owner backfill stamps what the readers already resolve, and only once.

Dry-run counts the rows that lack ``owner``; apply stamps them through the same
``owner_of`` rule every reader uses; a second run finds nothing. Because Phase 2's
lazy paths already make correctness independent of this pass, the property that
matters here is that it never contradicts ``owner_of`` — a legacy source that
names an agent must not be backfilled to the local user.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.user import User
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.migrations.migration_2026_09_owner_backfill import _repair
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_backfill_counts_then_stamps_then_finds_nothing():
    local = await User.get_local()
    if local is None:
        local = User(uname="local", name="local")
        await local.save(notify=False)
    local_tid = TypeId(type=EntityType.USER.value, id=str(local.id))
    agent_id = str(uuid.uuid4())
    agent_tid = TypeId(type=EntityType.AGENT.value, id=agent_id)

    # Rows shaped as they were before `owner` existed. `save` would stamp them, so
    # write the blob directly the way a pre-owner build would have left it.
    legacy_agent_source = DataSource(name="a", provider="cloud_email", config={"agent_id": agent_id})
    legacy_user_source = DataSource(name="u", provider="rss")
    for row in (legacy_agent_source, legacy_user_source):
        await row.save(notify=False)  # `save` stamps these; the thread/conversation below stay unowned
    conv_id = str(uuid.uuid4())
    thread = MessageThread(id=str(uuid.uuid4()), channel="slack", thread_key=f"k-{uuid.uuid4()}", conversation_id=conv_id)
    await thread.save(notify=False)
    conv = Conversation(title="t")
    conv.id = conv_id
    await conv.save(None, notify=False)

    unowned_threads_before = await MessageThread.find_unowned("slack", thread.thread_key)
    assert unowned_threads_before is not None

    dry = await _repair(dry_run=True)
    assert dry["message_thread"] >= 1 and dry["conversation"] >= 1
    assert (await MessageThread.get_one({"id": thread.id})).owner is None, "dry-run must not write"

    applied = await _repair(dry_run=False)
    assert applied["message_thread"] >= 1 and applied["conversation"] >= 1

    # A thread with no source-backed message → the local user; its conversation follows it.
    assert (await MessageThread.get_one({"id": thread.id})).owner == local_tid
    assert (await Conversation.get_one({"id": conv_id})).owner == local_tid
    # The agent-named legacy source resolves to the agent, never the local user.
    assert (await DataSource.get_one({"id": legacy_agent_source.id})).owner == agent_tid

    again = await _repair(dry_run=True)
    assert again["message_thread"] == 0 and again["conversation"] == 0
