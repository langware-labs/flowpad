"""A FlowMessage is a real local child of its Conversation.

The hub has always modelled it that way (``Conversation.add_message`` calls
``add_child``); locally the relationship was only ever denormalized — a
``conversation_id`` field plus a pointer list in ``conversation.jsonl``. That
left the parent with no edge to announce, which is how a synced message could
land in SQLite with the open conversation never told.

Covered here:
  * materializing a message creates the parent→child edge and stamps
    ``parent_type_id``
  * re-materializing the same message (live frame then catch-up, or a bundle
    re-unpack) does NOT duplicate the edge
  * ``parent_type_id`` survives a hub LWW refresh, whose payload never carries
    it (the hub's FlowMessage has no such field), because it is re-derived from
    the conversation on every pass rather than preserved
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root


@pytest.fixture()
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


async def _conversation() -> Conversation:
    conv = Conversation(id=str(uuid.uuid4()), title="child-edge")
    await conv.save()
    return conv


def _child_ids(kids) -> list[str]:
    return [getattr(k, "value", k).id for k in kids if getattr(k, "value", k) is not None]


@pytest.mark.asyncio
async def test_materialize_creates_the_child_edge(records_root):
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

    conv = await _conversation()
    fm = await materialize_flow_message(
        {"id": str(uuid.uuid4()), "text": "hello"},
        conversation_id=conv.id,
        someone_typeid=None,
        notify=False,
    )

    kids = await conv.get_children(child_filter=QueryFilter(type=FlowMessage.get_type()))
    assert fm.id in _child_ids(kids), "the message should be a child of its conversation"

    fresh = await FlowMessage.get_one({"id": fm.id})
    assert fresh.parent_type_id == str(conv.typeid)


@pytest.mark.asyncio
async def test_rematerializing_does_not_duplicate_the_edge(records_root):
    """Live frame then catch-up over the same id must leave exactly one edge."""
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

    conv = await _conversation()
    payload = {"id": str(uuid.uuid4()), "text": "twice"}
    await materialize_flow_message(payload, conversation_id=conv.id, someone_typeid=None, notify=False)
    await materialize_flow_message(payload, conversation_id=conv.id, someone_typeid=None, notify=False)

    kids = await conv.get_children(child_filter=QueryFilter(type=FlowMessage.get_type()))
    ids = _child_ids(kids)
    assert ids.count(payload["id"]) == 1, f"expected one edge, got {ids.count(payload['id'])}"


@pytest.mark.asyncio
async def test_parent_survives_a_hub_refresh_that_omits_it(records_root):
    """The hub payload has no ``parent_type_id``; ours must not be wiped.

    ``merge_hub_payload`` restores only PRIVATE / HUB_WRITE fields, and
    ``parent_type_id`` is SHARED (the hub-child path deliberately lets a
    payload's own value win). Rather than reclassify it globally, the sync
    re-derives it from the conversation it is syncing — so a hub refresh that
    omits the field heals instead of clobbering.
    """
    from flow_sdk.app.actions.flow_message_action import _process_single_hub_message
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

    conv = await _conversation()
    fm_id = str(uuid.uuid4())
    await materialize_flow_message(
        {"id": fm_id, "text": "v1"}, conversation_id=conv.id, someone_typeid=None, notify=False
    )

    # A hub row for the same message, newer, and WITHOUT parent_type_id —
    # exactly what the catch-up feeds in.
    await _process_single_hub_message(
        {
            "id": fm_id,
            "text": "v2 from the hub",
            "conversation_id": conv.id,
            "updated_date": "2030-01-01T00:00:00+00:00",
        }
    )

    fresh = await FlowMessage.get_one({"id": fm_id})
    assert fresh.text == "v2 from the hub", "precondition: the refresh should have applied"
    assert fresh.parent_type_id == str(conv.typeid), "the hub refresh wiped local parentage"
