"""C4 — purging a source takes its projection with it.

Under the reference model this cascade is mandatory, not hygiene: a projected
FlowMessage holds no body of its own, so a purge that left it behind would fill
the inbox with blank rows pointing at nothing.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.projection import project_source_item

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _projected_pair(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )
    src = DataSource(
        provider="agent", channel="gmail", name="Mail",
        account_key=f"acct-{uuid.uuid4().hex[:8]}",
    )
    await src.save()
    item = SourceItem(
        id=str(uuid.uuid4()),
        data_source_id=src.id,
        provider="agent",
        kind="content.message.email",
        segment_key="INBOX",
        external_id=f"<{uuid.uuid4().hex[:8]}@x>",
        name="Q3 planning",
        body="hello there",
        author_external_id="bob@example.com",
        thread_key=f"t-{uuid.uuid4().hex[:8]}",
    )
    await item.save(notify=False)
    result = await project_source_item(item, source=src, notify=False, announce=False)
    assert result is not None, "precondition: the item must project"
    return src, item, result


@pytest.mark.asyncio
async def test_purging_a_source_removes_messages_threads_and_the_conversation(
    monkeypatch, tmp_path
):
    src, item, (fm_id, thread_id) = await _projected_pair(tmp_path, monkeypatch)
    thread = await MessageThread.get_one({"id": thread_id})
    conv_id = thread.conversation_id
    assert await FlowMessage.get_by_id(fm_id) is not None
    assert await Conversation.get_one({"id": conv_id}) is not None

    await DataSource.purge_records_of(src.id)

    assert await SourceItem.get_all({"data_source_id": src.id}) == []
    assert await FlowMessage.get_all({"source_item_id": item.id}, hydrate=False) == []
    assert await MessageThread.get_one({"id": thread_id}) is None, (
        "an empty thread must not survive its messages"
    )
    assert await Conversation.get_one({"id": conv_id}) is None, (
        "a conversation with no messages and no threads left goes with them"
    )


@pytest.mark.asyncio
async def test_reprojection_after_purge_converges_on_fresh_rows(monkeypatch, tmp_path):
    """The lookup identity makes purge → re-poll a clean rebirth, not a dupe."""
    src, item, (fm_id, thread_id) = await _projected_pair(tmp_path, monkeypatch)
    await DataSource.purge_records_of(src.id)

    # The provider still has the mail; the next poll re-ingests and re-projects.
    await item.save(notify=False)
    result = await project_source_item(item, source=src, notify=False, announce=False)
    assert result is not None
    new_fm_id, new_thread_id = result
    assert new_fm_id != fm_id and new_thread_id != thread_id, "fresh v4 rows"
    rows = await FlowMessage.get_all({"source_item_id": item.id}, hydrate=False)
    assert len(rows) == 1, "and exactly one of them"
