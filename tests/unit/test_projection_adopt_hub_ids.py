"""A record that names the hub's own ids lands on the hub-mirrored rows.

The help desk is written by two hands: the source projection (this machine
polls the desk) and the hub mirror (once the owner is a participant, the hub
fans the ticket's messages out). Without adoption each hand writes its own
Conversation and its own FlowMessage — one ticket, two rows, and a reply box
that cannot find a channel. With it, both converge on one row whichever hand
writes first, and a hub refresh never strips the projection's own fields.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
from flow_sdk.builtin.conversation import Conversation, ConversationKind
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.projection import project_source_item

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DESK = "4f9f1fd1-39b6-5465-9c20-cb4c59b08318"


async def _desk_source() -> DataSource:
    src = DataSource(name="desk", provider="helpdesk", channel="helpdesk", config={"desk_project_id": DESK})
    await src.save()
    return src


async def _ticket_item(src: DataSource, ticket: str, fm_id: str, *, text="my printer is broken") -> SourceItem:
    item = SourceItem(
        kind="content.message.chat", provider="helpdesk", data_source_id=str(src.id),
        segment_key=ticket, external_id=fm_id, thread_key=f"{DESK}:{ticket}",
        body=text, occurred_at="2026-09-06T10:00:00+00:00",
        author_external_id="guest-1", author_display="Guest",
        conversation_id=ticket, message_id=fm_id,
    )
    await item.save()
    return item


async def test_the_thread_adopts_the_hub_conversation_and_the_message_takes_the_hub_id():
    src = await _desk_source()
    ticket, fm_id = str(uuid.uuid4()), str(uuid.uuid4())
    item = await _ticket_item(src, ticket, fm_id)

    placed_fm, thread_id = await project_source_item(item, source=src, notify=False, announce=False)

    assert placed_fm == fm_id, "the FlowMessage was minted with the hub's message id"
    thread = await MessageThread.get_by_id(thread_id)
    assert thread.conversation_id == ticket, "the thread adopted the hub conversation instead of minting one"
    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm.origin.kind == "helpdesk" and fm.thread_id == thread_id and fm.source_item_id == str(item.id)


async def test_a_row_the_hub_mirror_wrote_first_is_claimed_not_twinned():
    """The other order: pickup happened, the mirror materialized the ticket and
    its message, THEN the desk source polled it."""
    src = await _desk_source()
    ticket, fm_id = str(uuid.uuid4()), str(uuid.uuid4())
    conv = Conversation(id=ticket, title="my printer is broken", kind=ConversationKind.HELPDESK, remote=True)
    await conv.save()
    await materialize_flow_message(
        {"id": fm_id, "text": "my printer is broken", "sender_id": "guest-1", "sender_name": "Guest",
         "updated_date": "2026-09-06T10:00:00+00:00"},
        ticket, someone_typeid=None, notify=False, remote=True,
    )
    item = await _ticket_item(src, ticket, fm_id)

    placed_fm, thread_id = await project_source_item(item, source=src, notify=False, announce=False)
    await project_source_item(item, source=src, notify=False, announce=False)  # idempotent

    assert placed_fm == fm_id
    assert len(await FlowMessage.get_all({"conversation_id": ticket})) == 1, "one ticket message, one row"
    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm.source_item_id == str(item.id) and fm.origin.kind == "helpdesk" and fm.thread_id == thread_id
    conv = await Conversation.get_one({"id": ticket})
    assert conv.kind == ConversationKind.HELPDESK and conv.remote is True, "the hub-owned facts survive"


async def test_a_hub_refresh_never_strips_the_projections_fields():
    """The mirror refreshes a message the projection already placed. The hub
    payload carries no origin and no thread — absence must not blank them."""
    src = await _desk_source()
    ticket, fm_id = str(uuid.uuid4()), str(uuid.uuid4())
    item = await _ticket_item(src, ticket, fm_id)
    await project_source_item(item, source=src, notify=False, announce=False)

    await materialize_flow_message(
        {"id": fm_id, "text": "my printer is broken (edited)", "sender_id": "guest-1", "sender_name": "Guest",
         "updated_date": "2036-01-01T00:00:00+00:00"},
        ticket, someone_typeid=None, notify=False, remote=True,
    )

    fm = await FlowMessage.get_one({"id": fm_id})
    assert fm.origin is not None and fm.origin.kind == "helpdesk"
    assert fm.thread_id and fm.source_item_id == str(item.id)
    assert "origin" in FlowMessage.fields_not_accepted_from_hub()


async def test_a_record_without_hints_still_mints_as_before():
    """Every other channel is untouched: no hints, ordinary uuid4 births."""
    src = DataSource(name="tg", provider="telegram", channel="telegram", account_key="@b")
    await src.save()
    item = SourceItem(
        kind="content.message.chat", provider="telegram", data_source_id=str(src.id),
        segment_key="updates", external_id="1/abc", thread_key="1", body="hi",
        occurred_at="2026-09-06T10:00:00+00:00", author_external_id="7",
    )
    await item.save()
    placed_fm, thread_id = await project_source_item(item, source=src, notify=False, announce=False)
    thread = await MessageThread.get_by_id(thread_id)
    assert placed_fm != item.external_id and thread.conversation_id != item.external_id
