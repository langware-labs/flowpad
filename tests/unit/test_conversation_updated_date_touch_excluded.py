"""Conversation recency excludes hub *touches*.

Contract (the inbox "Xm ago" clock):

    ``Conversation.updated_date`` is the last message's ``updated_date`` — i.e.
    the moment of the last *real* change to a message object (a new message, or
    a genuine edit to its content/state). A bare **touch** of a message — the
    hub re-materializing / re-downloading the body, re-emitting an unchanged
    row, bumping its ``updated_date``/``fetched_at`` with no real field change —
    must NOT advance it.

This pins the prod incident (conversation 64affa19): its only message was born
12:41 yet the inbox showed it as "57m ago" because a 16:27 body re-download
touched the message — the hub bumped the message AND parent ``updated_date`` and
the local row adopted the touch clock verbatim. The last *message* never
changed; the recency did.

The contract splits into composing switches, one test layer each:

1. ``FlowMessage.is_stale`` — the message-level LWW decision. A pure touch
   (every hub-owned field identical, only ``updated_date`` newer) is NOT stale;
   a real edit IS. This is the upstream switch proven in the RCA.
2. ``project_pointers_to_entity`` — conversation recency is derived from the
   last message's ``updated_date`` (the real-change clock), not its
   ``created_date`` / pointer ts.
3. ``_upsert_hub_conversation_metadata`` — a touched hub *parent* clock must not
   drag local recency past the last real message change.

Tests marked ``# CAPTURES BUG`` fail against the current code on purpose — they
encode the contract the fix must satisfy.
"""

from __future__ import annotations

import pytest

from flow_sdk.app.actions.flow_message_action import _upsert_hub_conversation_metadata
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.fs_store.operations.conversation import (
    append_message_pointer,
    default_jsonl_path,
    from_jsonl,
    project_pointers_to_entity,
)

_FM_ID = "d3b466e3-786a-4e2a-808f-c3c4ab99232c"
_BORN = "2026-06-22T12:41:56.150316+00:00"   # the message's real birth/edit time
_TOUCH = "2026-06-22T16:27:53.121628+00:00"  # ~4h later: a body re-download only


def _local_fm(**over) -> FlowMessage:
    """A settled, hub-confirmed message as it sits in the local DB."""
    base = {
        "id": _FM_ID,
        "text": "Find a smartphone",
        "delivery_status": "received",
        "created_date": _BORN,
        "updated_date": _BORN,
        "remote": True,
    }
    base.update(over)
    return FlowMessage.model_validate(base)


def _hub_echo(**over) -> dict:
    """The hub's payload for that same message on a later sync pass."""
    raw = {
        "id": _FM_ID,
        "text": "Find a smartphone",
        "delivery_status": "received",
        "created_date": _BORN,
        "updated_date": _BORN,
    }
    raw.update(over)
    return raw


def _dt(value):
    return Conversation._as_datetime(value)


# --------------------------------------------------------------------------
# Layer 1 — message LWW: real change vs. touch (pure, no DB, no mocks)
# --------------------------------------------------------------------------

@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_real_edit_is_stale():
    """A genuine content edit (text changed) with a newer updated_date is a real
    change — the local row must refresh."""
    local = _local_fm()
    edit = _hub_echo(text="Find a cheap smartphone", updated_date=_TOUCH)
    assert FlowMessage.is_stale(local, edit) is True


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_real_status_change_is_stale():
    """A genuine delivery-state transition is a real change."""
    local = _local_fm(delivery_status="sent")
    delivered = _hub_echo(delivery_status="received", updated_date=_TOUCH)
    assert FlowMessage.is_stale(local, delivered) is True


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_pure_touch_is_not_stale():  # CAPTURES BUG
    """Body re-download / re-materialize: every hub-owned field is identical to
    the local row, only ``updated_date`` (and the local-only ``fetched_at``)
    moved. That is a touch, not a change — it must NOT be treated as stale, so
    the local message's ``updated_date`` never advances to the touch clock.

    Current code compares ``updated_date`` alone, so this returns True — the
    exact upstream switch behind the stale inbox recency."""
    local = _local_fm()
    touch = _hub_echo(updated_date=_TOUCH)  # same text/status/created_date
    assert FlowMessage.is_stale(local, touch) is False


# --------------------------------------------------------------------------
# Layer 2 — recency is derived from the last message's updated_date
#           (real Conversation + FlowMessage rows + on-disk pointers)
# --------------------------------------------------------------------------

async def _conv_with_message(
    conv_id: str, msg_id: str, *, created: str, updated: str
) -> None:
    """Persist a remote conversation with one real message row + pointer."""
    conv = Conversation.model_validate(
        {"id": conv_id, "title": "Find a smartphone", "remote": True,
         "updated_date": created, "created_date": created}
    )
    conv.id = conv_id
    await conv.save(None, notify=False)
    fm = _local_fm(id=msg_id, created_date=created, updated_date=updated)
    await fm.save()
    # The pointer index orders by the message's birth time (created_date).
    rec = from_jsonl(default_jsonl_path(conv_id), parent_id="", record_id=conv_id)
    append_message_pointer(rec, msg_id, created)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_recency_equals_message_time_when_unedited():
    """Baseline: a never-edited message (created == updated) gives recency =
    that message's time."""
    conv_id = "1a1a0001-1111-4111-8111-000000000001"
    msg_id = "1a1a0001-2222-4222-8222-000000000001"
    await _conv_with_message(conv_id, msg_id, created=_BORN, updated=_BORN)
    rec = from_jsonl(default_jsonl_path(conv_id), parent_id="", record_id=conv_id)
    await project_pointers_to_entity(rec, notify=False)

    conv = await Conversation.get_one({"id": conv_id})
    assert _dt(conv.updated_date) == _dt(_BORN)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_recency_follows_message_updated_date_on_real_edit():  # CAPTURES BUG
    """A message born at _BORN but really edited at _TOUCH (created stays _BORN,
    updated_date advances) must drive conversation recency to _TOUCH.

    Current ``project_pointers_to_entity`` uses the pointer ts (the message's
    created_date), so recency stays at _BORN and a real edit never surfaces."""
    conv_id = "1a1a0002-1111-4111-8111-000000000002"
    msg_id = "1a1a0002-2222-4222-8222-000000000002"
    await _conv_with_message(conv_id, msg_id, created=_BORN, updated=_TOUCH)
    rec = from_jsonl(default_jsonl_path(conv_id), parent_id="", record_id=conv_id)
    await project_pointers_to_entity(rec, notify=False)

    conv = await Conversation.get_one({"id": conv_id})
    assert _dt(conv.updated_date) == _dt(_TOUCH)


# --------------------------------------------------------------------------
# Layer 3 — a touched hub parent clock must not drag recency forward
#           (real local row in the test DB)
# --------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_touched_parent_clock_does_not_advance_recency():  # CAPTURES BUG
    """The prod incident at the local boundary: the conversation's last (and
    only) real message change is _BORN; a hub parent echo whose ``updated_date``
    jumped to the touch clock — with the same message set — must not move local
    recency past _BORN.

    Current ``_upsert_hub_conversation_metadata`` adopts the hub parent clock
    verbatim (is_stale → updated_date = hub updated_date), so recency jumps to
    16:27 and the days-old conversation floats to the top of the inbox."""
    conv_id = "64affa19-02d9-4fe2-97e2-8978af187460"
    msg_id = "d3b466e3-786a-4e2a-808f-c3c4ab99232c"
    await _conv_with_message(conv_id, msg_id, created=_BORN, updated=_BORN)

    # Hub parent echo: same single message, parent clock bumped by a body
    # re-download (no new or edited message).
    await _upsert_hub_conversation_metadata(
        {"id": conv_id, "title": "Find a smartphone",
         "updated_date": _TOUCH, "message_count": 1},
        someone_typeid=None, notify=False,
    )

    conv = await Conversation.get_one({"id": conv_id})
    assert _dt(conv.updated_date) == _dt(_BORN)
