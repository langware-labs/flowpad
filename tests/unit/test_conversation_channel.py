"""A source-backed conversation names its channel and source; the view reads them, derives nothing."""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.projection import _stamp_channel, project_source_item
from flow_sdk.ingest import IngestMode, SourceItemSpec, ingest_items


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_projected_conversation_names_its_channel_and_source():
    tag = uuid.uuid4().hex[:8]
    src = DataSource(provider="slack", channel="slack", account_key=f"T-{tag}", name=f"Chat {uuid.uuid4().hex[:8]}", config={"channels": ["C0123456789"]})
    await src.save()
    spec = SourceItemSpec(
        data_source_id=str(src.id), provider="slack", kind="content.message.chat", segment_key="C1",
        external_id=f"m-{tag}", body="hi", thread_key=f"th-{tag}", author_external_id="U1",
    )
    report = await ingest_items([spec], mode=IngestMode.for_run(item_count=10_000))
    row = await SourceItem.get_one({"id": report.outcomes[0].entity_id})

    _, thread_id = await project_source_item(row, source=src, announce=False)

    thread = await MessageThread.get_one({"id": thread_id})
    conversation = await Conversation.get_one({"id": thread.conversation_id})
    assert (conversation.channel, conversation.channel_source_id) == ("slack", str(src.id))


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_stamped_pointer_is_never_moved_by_a_twin_source():
    class Row:
        channel, channel_source_id = "slack", "first"

        async def save(self, **_):
            raise AssertionError("nothing to write")

    await _stamp_channel(Row(), "slack", "second")
