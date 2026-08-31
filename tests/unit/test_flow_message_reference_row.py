"""C1 pins for the reference-row model.

A FlowMessage carrying ``source_item_id`` is a REFERENCE row: its body lives on
the SourceItem it points at and is hydrated at read time. Two invariants are
pinned here, both load-bearing for everything built on top:

* ``save()`` blanks ``text`` on a reference row — any consumer that loads a
  hydrated row and saves it back (an ``is_read`` toggle, an archive) must not
  persist the hydrated body and resurrect the copy model.
* ``MessageThread`` resolves by its natural key ``(channel, thread_key)`` — a
  lookup, like SourceItem — so re-projection converges on one row without a
  derived id.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread


def _fm(**kw) -> FlowMessage:
    base = dict(
        id=str(uuid.uuid4()),
        conversation_id=str(uuid.uuid4()),
        text="a body that must not be persisted",
    )
    base.update(kw)
    return FlowMessage(**base)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_save_blanks_text_on_a_reference_row():
    # The referenced item deliberately does not exist: hydration (when it
    # lands) stitches nothing for a missing item, so this pin stays valid.
    fm = _fm(source_item_id=str(uuid.uuid4()))
    await fm.save(notify=False)
    assert fm.text == "", "save() must blank text on a reference row"

    stored = await FlowMessage.get_one({"id": fm.id})
    assert stored is not None
    assert stored.text == "", "the persisted row must carry no body"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_save_keeps_text_on_a_native_row():
    fm = _fm()
    await fm.save(notify=False)
    stored = await FlowMessage.get_one({"id": fm.id})
    assert stored.text == "a body that must not be persisted", (
        "a hub-native message owns its text; the guard must not touch it"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_message_thread_resolves_by_natural_key():
    channel, key = "gmail", f"t-{uuid.uuid4().hex[:8]}"
    thread = MessageThread(
        id=str(uuid.uuid4()), channel=channel, thread_key=key,
        conversation_id=str(uuid.uuid4()), name="Q3 planning",
    )
    await thread.save()

    found = await MessageThread.find_existing(channel, key)
    assert found is not None and found.id == thread.id

    assert await MessageThread.find_existing("slack", key) is None, (
        "the key is channel-scoped; another channel must not resolve this row"
    )
