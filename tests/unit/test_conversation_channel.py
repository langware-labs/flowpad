"""Every conversation has a channel: born `flowpad`, adopted by the source that projects into it.

The view reads `channel_spec` — chip, transport, attachments — and never tests the channel's name."""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest import IngestMode, SourceItemSpec, ingest_items
from flow_sdk.stream_inbox.projection import project_source_item


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_projected_conversation_names_its_channel_and_source():
    tag = uuid.uuid4().hex[:8]
    src = DataSource(provider="slack", channel="slack", account_key=f"T-{tag}", name=f"Chat {uuid.uuid4().hex[:8]}", config={"channel": "C0123456789"})
    await src.save()
    spec = SourceItemSpec(
        data_source_id=str(src.id), provider="slack", kind="content.message.chat",
        external_id=f"m-{tag}", body="hi", thread_key=f"th-{tag}", author_external_id="U1",
    )
    report = await ingest_items([spec], mode=IngestMode.for_run(item_count=10_000))
    row = await SourceItem.get_one({"id": report.outcomes[0].entity_id})

    _, thread_id = await project_source_item(row, source=src, announce=False)

    thread = await MessageThread.get_one({"id": thread_id})
    conversation = await Conversation.get_one({"id": thread.conversation_id})
    assert (conversation.channel, conversation.channel_source_id) == ("slack", str(src.id))


def test_a_new_conversation_is_flowpads_own_chat_and_wears_no_chip():
    spec = Conversation(title="hi").channel_spec
    assert (spec.name, spec.chip, spec.transport, spec.accepts_attachments) == ("flowpad", False, "flowpad", True)


def test_a_row_written_before_every_conversation_had_a_channel_is_flowpads():
    assert Conversation.model_validate({"id": str(uuid.uuid4()), "channel": None}).channel == "flowpad"


def test_a_source_channel_replaces_home_but_is_never_moved_by_a_twin_source():
    ticket = Conversation(title="ticket")
    assert ticket.adopt_channel("helpdesk", "desk-source") and ticket.channel == "helpdesk"
    assert ticket.adopt_channel("slack", "twin") is False, "nothing to write"
    assert (ticket.channel, ticket.channel_source_id) == ("helpdesk", "desk-source")


def test_a_source_channel_wears_a_chip_and_replies_through_its_source():
    spec = Conversation(title="t", channel="slack").channel_spec
    assert (spec.chip, spec.transport, spec.home, spec.accepts_attachments) == (True, "source", False, False)
