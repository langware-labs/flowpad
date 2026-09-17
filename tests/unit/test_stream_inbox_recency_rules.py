"""The three rules that keep the inbox still while a backlog downloads.

Each was proven by toggling it against real data during a live hub switch, and
each was then shipped without a test. This file is that debt: every test here
must FAIL if its fix is deleted — the previous version of the bundle test passed
either way, because its fixture built a shape the product almost never produces.

  * ``fetch_order``            — newest message first, so a conversation lands in
                                 its final slot on the first write
  * ``_restore_send_time``     — the hub's delivery clock beats the send-time
                                 guess when the caller has one
  * empty-conversation recency — a thread with no messages sorts by its own birth
                                 time, not by the sync instant
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root

UTC = timezone.utc


@pytest.fixture(autouse=True)
def _roots(tmp_path, monkeypatch):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path / "data",
    )
    yield
    set_default_records_root(original)


# ---------------------------------------------------------------------------
# fetch_order — newest first
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_messages_are_materialized_newest_first():
    """The newest message must be processed FIRST.

    Recency is ``max(updated_date)``, so processing the newest first makes the
    conversation's position right after one write. Oldest-first leaves it wrong
    until the last arrival and moves the row on every message in between.
    """
    from flow_sdk.app.actions.flow_message_action import fetch_order

    hub_messages = [
        {"id": "oldest", "created_date": "2026-06-14T11:35:02+00:00"},
        {"id": "newest", "created_date": "2026-08-03T17:25:03+00:00"},
        {"id": "middle", "created_date": "2026-07-05T07:37:15+00:00"},
    ]
    assert [m["id"] for m in fetch_order(hub_messages)] == ["newest", "middle", "oldest"], (
        "oldest-first ordering is back — the conversation will climb the inbox on "
        "every message instead of landing in place on the first"
    )


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_fetch_order_tolerates_a_missing_created_date():
    """A dateless hub row must not blow up the sort — it sorts last, not crash."""
    from flow_sdk.app.actions.flow_message_action import fetch_order

    out = fetch_order([{"id": "dated", "created_date": "2026-08-03T17:25:03+00:00"}, {"id": "undated"}])
    assert [m["id"] for m in out] == ["dated", "undated"]


# ---------------------------------------------------------------------------
# _restore_send_time — the hub's clock wins over the send-time guess
# ---------------------------------------------------------------------------


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_hub_delivery_clock_beats_the_send_time_guess(tmp_path):
    """``updated_date`` is when the message REACHED the recipient, not when it was
    written — the hub stamps it (``received_at`` is HUB_WRITE). The pointer index
    inside the bundle only knows the send time, so filling ``updated_date`` from it
    puts the conversation days into the past until the hub corrects it a beat
    later. Measured live: a 3-day dip, a conversation diving ~10 places and
    snapping back.
    """
    from flow_sdk.builtin.flow_message_bundle import _restore_send_time

    sent = "2026-07-05T08:01:20+00:00"
    delivered = "2026-07-05T08:34:22+00:00"

    # Stand in for the pointer index the bundle carries.
    import flow_sdk.builtin.flow_message_bundle as mod

    original = mod._send_time_from_pointer_index
    mod._send_time_from_pointer_index = lambda root, fm_id: sent
    try:
        with_hub: dict = {}
        _restore_send_time(with_hub, tmp_path, "fm-1", delivered)
        without_hub: dict = {}
        _restore_send_time(without_hub, tmp_path, "fm-1", None)
    finally:
        mod._send_time_from_pointer_index = original

    assert with_hub["created_date"] == sent, "birth time must always come from the send time"
    assert with_hub["updated_date"] == delivered, (
        "the hub's delivery clock was available and was ignored — the row will land "
        "days early and the conversation will dip until the next sync repairs it"
    )
    # No hub value (a .flowmsg shared as a file): the send time is the honest
    # fallback, and there is no second writer to cause a dip.
    assert without_hub["updated_date"] == sent


# ---------------------------------------------------------------------------
# empty-conversation recency
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_conversation_with_no_messages_sorts_by_its_own_birth_time():
    """With no messages there is nothing to derive recency from. Falling back to
    ``now()`` re-stamps every empty conversation on every sync pass and floats it
    above threads with real content — 21 of them sat at the top of a real inbox.
    Its own creation time is the honest answer.
    """
    from flow_sdk.fs_store.operations.conversation import (
        default_jsonl_path,
        from_jsonl,
        project_pointers_to_entity,
    )
    from flow_sdk.fs_store.record_types import RecordType

    born = datetime(2026, 7, 30, 14, 16, 39, tzinfo=UTC)
    conv = Conversation(id=str(uuid.uuid4()), title="Shared doc", remote=True)
    conv.created_date = born
    conv.updated_date = born
    await conv.save()

    rec = from_jsonl(default_jsonl_path(conv.id), parent_id="", record_id=conv.id, parent_type=RecordType.PROJECT)
    await project_pointers_to_entity(rec, notify=False)

    after = await Conversation.get_one({"id": conv.id})
    assert after is not None
    recency = Conversation._as_datetime(after.updated_date)
    assert recency == born, (
        f"an empty conversation was re-stamped to {recency} instead of keeping its own "
        f"birth time {born} — it will float to the top of the inbox on every sync"
    )
    assert datetime.now(UTC) - recency > timedelta(days=1), "recency is the sync instant, not the birth time"
