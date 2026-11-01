"""One mirror for every hub conversation row (``Entity.mirror_from_hub``), driven by the declarations.

* the hub's owner (``initiated_by``) and roster (``members``) land under the same names,
  the roster in the local shape;
* ``picked_up_by`` is the hub's list of staffers — a type mismatch here used to abort the whole row;
* a synced ``null`` never clears a local value (a guest ticket's title is the local one);
* this user's own state (``archived_at``) and local recency (``updated_date``) never come from the hub;
* a row the hub deleted is dropped;
* the context links this machine made are merged with the hub's, never replaced by its empty list.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.conversation import Conversation, ConversationKind


async def _local(**fields) -> Conversation:
    conv = Conversation(id=mint_uuid(), remote=True, **fields)
    await conv.save()
    return conv


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_hub_ticket_row_lands_whole():
    archived = datetime(2026, 1, 1, tzinfo=timezone.utc)
    conv = await _local(title="Help with sync", archived_at=archived)
    await Conversation.mirror_from_hub(
        {
            "id": conv.id,
            "title": None,
            "kind": "helpdesk",
            "status": "closed",
            "initiated_by": "requester-1",
            "picked_up_by": ["staff-1"],
            "members": [{"user_id": "staff-1", "user_email": "Staff@Desk.test", "role": "member"}],
            "archived_at": None,
            "updated_date": "2030-01-01T00:00:00Z",
        }
    )
    row = await Conversation.get_by_id(conv.id)
    assert row.title == "Help with sync"
    assert row.kind == ConversationKind.HELPDESK and row.status == "closed"
    assert row.initiated_by == "requester-1"
    assert row.picked_up_by == ["staff-1"]
    assert row.members[0]["email"] == "staff@desk.test"
    assert row.archived_at == archived
    assert row.updated_date is None or row.updated_date.year != 2030


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_new_hub_row_is_created_remote_and_a_deleted_one_is_dropped():
    conv_id = mint_uuid()
    created = await Conversation.mirror_from_hub({"id": conv_id, "title": "From the hub", "initiated_by": "u-1"})
    assert created is not None and created.remote is True and created.initiated_by == "u-1"
    assert await Conversation.mirror_from_hub({"id": conv_id, "deleted_at": "2030-01-01T00:00:00Z"}) is None
    assert await Conversation.get_by_id(conv_id) is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_channel_comes_from_the_hub_and_a_hub_without_one_keeps_ours():
    conv = await _local(channel="gmail")
    await Conversation.mirror_from_hub({"id": conv.id, "channel": None, "title": "t"})
    assert (await Conversation.get_by_id(conv.id)).channel == "gmail"
    await Conversation.mirror_from_hub({"id": conv.id, "channel": "slack"})
    assert (await Conversation.get_by_id(conv.id)).channel == "slack"
    assert "channel" not in Conversation.fields_not_sent_to_hub()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_hub_rows_empty_context_never_erases_this_machines_links():
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    conv = await _local(title="t")
    session = TypeId(type="agentic_process", id=mint_uuid())
    conv.add_shared_context_entities(session, data={"role": "session"})
    await conv.save()
    await Conversation.mirror_from_hub({"id": conv.id, "title": "t", "shared_context_entities": []})
    row = await Conversation.get_by_id(conv.id)
    assert session in row.shared_context_entities
    assert row.shared_context_entity_data[str(session)] == {"role": "session"}
