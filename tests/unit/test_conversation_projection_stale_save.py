"""A save from a stale copy never rolls a conversation's projection back.

QC 2026-10-01 (hub_playwright ``setup_conversation``): an inbound message was
in the pointer index AND the parent→child edge table, yet missing from the
conversation row's ``message_ids`` — so the open conversation never showed it.
Every conversation write is a whole-row upsert, and several writers hold a copy
read BEFORE the projection last moved: the hub bridge's conversation frame
(``_handle_conversation_op``: ``get_one`` … ``save``), the GET-time disk→DB
record refresh (``from_record``), the unread recount. Whichever saved last
wrote its stale ``message_ids`` over the fresh projection.

The fix is the projection guard's missing piece: a save adopts, from the stored
row, every projected field it did not itself set through ``_set_projection``.
Only the hub's HTTP response is stubbed; the sync, the projection and the saves
are real.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _fetch_conversation_messages
from flow_sdk.builtin.conversation import _PROJECTION_SENTINEL, Conversation
from flow_sdk.fs_store.operations.conversation import (
    default_jsonl_path,
    from_jsonl,
    project_pointers_to_entity,
)

import uuid


def _msg(conv_id: str, mid: str, at: str) -> dict:
    return {
        "id": mid, "conversation_id": conv_id, "text": f"msg {mid[-2:]}",
        "sender_name": "alice", "sender_id": "alice-user-id", "delivery_status": "sent",
        "created_date": at, "updated_date": at,
    }


async def _arrive(conv_id: str, children: list[dict]) -> Conversation:
    """One real children-list sync + projection; returns the stored row."""
    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        new=AsyncMock(return_value=children),
    ):
        assert await _fetch_conversation_messages(conv_id, someone_typeid=None) is True
    rec = from_jsonl(default_jsonl_path(conv_id), parent_id="", record_id=conv_id)
    await project_pointers_to_entity(rec, notify=False)
    return await Conversation.get_one({"id": conv_id})


def _ids(conv: Conversation) -> list[str]:
    return [p["typeid"].split("-", 1)[1] for p in json.loads(conv.message_ids or "[]")]


async def _two_arrivals_and_a_stale_copy() -> tuple[str, list[str], Conversation]:
    """A conversation, a copy of it read after its first message, then a second
    message projected — the copy is now exactly what a racing writer holds."""
    conv_id, first_id, second_id = (str(uuid.uuid4()) for _ in range(3))
    canonical = default_jsonl_path(conv_id)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("")
    conv = Conversation.model_validate({"id": conv_id, "title": "qc", "remote": True})
    conv.id = conv_id
    await conv.save(None, notify=False)
    first = [_msg(conv_id, first_id, "2026-10-01T08:00:00+00:00")]
    assert _ids(await _arrive(conv_id, first)) == [first_id], "precondition: the first message is projected"
    stale = await Conversation.get_one({"id": conv_id})
    fresh = await _arrive(conv_id, first + [_msg(conv_id, second_id, "2026-10-01T08:00:05+00:00")])
    assert _ids(fresh) == [first_id, second_id], "precondition: the second message is projected"
    return conv_id, [first_id, second_id], stale


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_stale_copy_save_keeps_the_newer_projection():
    """CAPTURES BUG — a writer's copy read before the second message landed."""
    conv_id, both, stale = await _two_arrivals_and_a_stale_copy()

    # The hub frame's write: a roster/title field on a copy read earlier.
    stale.title = "renamed on the hub"
    await stale.save(None, notify=False)

    stored = await Conversation.get_one({"id": conv_id})
    assert stored.title == "renamed on the hub", "the writer's own field still lands"
    assert _ids(stored) == both, (
        "a save from a copy read before the second message arrived rolled "
        "message_ids back — the new message vanished from the conversation row"
    )
    assert stored.message_count == 2


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_projection_writer_keeps_what_it_set_and_adopts_the_rest():
    """The unread recount sets is_unread on its copy; message_ids is not its to write."""
    conv_id, both, stale = await _two_arrivals_and_a_stale_copy()

    stale._set_projection("is_unread", True, _PROJECTION_SENTINEL)
    stale._set_projection("unread_count", 7, _PROJECTION_SENTINEL)
    await stale.save(None, notify=False)

    stored = await Conversation.get_one({"id": conv_id})
    assert stored.is_unread is True and stored.unread_count == 7, "its own projection lands"
    assert _ids(stored) == both, "the message projection it did not set is kept"
