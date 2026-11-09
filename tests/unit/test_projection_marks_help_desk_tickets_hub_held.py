"""A help-desk ticket the desk source copies here is the hub's conversation, and the row says so.

The desk source projects every queued ticket into a local conversation whose id is the hub's own. Left
unmarked (``remote`` False) the row reads as written on this machine, so the app takes the viewer for the
person who asked and a staff member is offered no pickup until a reply happens to flip it.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation, ConversationKind
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.stream_inbox.projection import project_source_item

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _queued_ticket() -> tuple[DataSource, SourceItem, str]:
    desk = str(uuid.uuid4())
    source = DataSource(
        name=f"desk {uuid.uuid4().hex[:8]}", provider="helpdesk", channel="helpdesk", config={"desk_project_id": desk}
    )
    await source.save()
    ticket, message = str(uuid.uuid4()), str(uuid.uuid4())
    item = SourceItem(
        kind="content.message.chat",
        provider="helpdesk",
        data_source_id=str(source.id),
        external_id=message,
        thread_key=f"{desk}:{ticket}",
        body="my printer is broken",
        occurred_at="2026-09-06T10:00:00+00:00",
        author_external_id="guest-1",
        author_display="Guest",
        conversation_id=ticket,
        message_id=message,
    )
    await item.save()
    return source, item, ticket


async def test_a_ticket_the_desk_source_projects_is_the_hubs_conversation(initialize_test_db) -> None:
    source, item, ticket = await _queued_ticket()

    await project_source_item(item, source=source, notify=False, announce=False)

    conversation = await Conversation.get_one({"id": ticket})
    assert conversation.kind == ConversationKind.HELPDESK.value
    assert conversation.remote is True


async def test_a_ticket_projected_before_the_mark_existed_is_marked_on_the_next_projection(initialize_test_db) -> None:
    source, item, ticket = await _queued_ticket()
    await project_source_item(item, source=source, notify=False, announce=False)
    conversation = await Conversation.get_one({"id": ticket})
    conversation.remote = False
    await conversation.save(notify=False)

    await project_source_item(item, source=source, notify=False, announce=False)

    assert (await Conversation.get_one({"id": ticket})).remote is True
