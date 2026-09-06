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
    # The referenced item deliberately does not exist: hydration stitches
    # nothing for a missing item, so the stored-blank assertion stays valid.
    fm = _fm(source_item_id=str(uuid.uuid4()))
    await fm.save(notify=False)
    # Blank-AROUND, not blank-forever: the write persists "" but the live
    # instance keeps what it held — that is what lets materialize emit the
    # read shape without re-hydrating.
    assert fm.text == "a body that must not be persisted"

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


def _item(**kw):
    from flow_sdk.builtin.source_item import SourceItem

    base = dict(
        id=str(uuid.uuid4()),
        data_source_id=str(uuid.uuid4()),
        provider="agent",
        kind="content.message.email",
        segment_key="INBOX",
        external_id=f"<{uuid.uuid4().hex[:8]}@x>",
        name="Q3 planning",
        body="the actual body, living on the item",
    )
    base.update(kw)
    return SourceItem(**base)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reads_hydrate_the_body_from_the_item():
    item = _item()
    await item.save(notify=False)
    fm = _fm(source_item_id=item.id)
    await fm.save(notify=False)

    # get_one funnels through get_all; both must hand back the item's body.
    got = await FlowMessage.get_one({"id": fm.id})
    assert got.text == "the actual body, living on the item"

    # get_by_id is a separate read path (the middleware preload) — it must
    # hydrate on its own or the single-message view reads blank.
    got = await FlowMessage.get_by_id(fm.id)
    assert got.text == "the actual body, living on the item"

    # The raw row stays blank — hydrate=False is the storage truth.
    raw = (await FlowMessage.get_all({"id": fm.id}, hydrate=False))[0]
    assert raw.text == ""


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_item_edit_is_visible_with_no_message_write():
    item = _item()
    await item.save(notify=False)
    fm = _fm(source_item_id=item.id)
    await fm.save(notify=False)
    stamped = (await FlowMessage.get_all({"id": fm.id}, hydrate=False))[0].updated_date

    item.body = "edited at the provider"
    await item.save(notify=False)

    got = await FlowMessage.get_one({"id": fm.id})
    assert got.text == "edited at the provider", (
        "the reference model's whole point: an item edit needs no FM write"
    )
    unchanged = (await FlowMessage.get_all({"id": fm.id}, hydrate=False))[0].updated_date
    assert unchanged == stamped, "no write may land on the message row"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_read_state_toggle_does_not_persist_the_hydrated_body():
    item = _item()
    await item.save(notify=False)
    fm = _fm(source_item_id=item.id)
    await fm.save(notify=False)

    # The exact loop the guard exists for: load hydrated, toggle, save.
    got = await FlowMessage.get_one({"id": fm.id})
    assert got.text  # hydrated
    got.is_read = True
    await got.save(notify=False)

    raw = (await FlowMessage.get_all({"id": fm.id}, hydrate=False))[0]
    assert raw.text == "", "the toggle save must not resurrect the copy"
    assert raw.is_read is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_announced_op_carries_the_hydrated_body(monkeypatch):
    """The socket frame is serialized the moment the op is announced. A
    reference row is announced AFTER its body is restored, so a live viewer
    never receives the stored (blank) shape — that frame blanked every
    requester line in an open ticket until a reload."""
    seen: list = []

    async def capture(op_message, notify_immediately=False):
        seen.append((op_message.op, op_message.data.text))

    monkeypatch.setattr(FlowMessage, "add_entity_op_notification", staticmethod(capture))
    fm = _fm(source_item_id=str(uuid.uuid4()))
    await fm.save()
    assert seen and seen[-1][1] == "a body that must not be persisted", seen
    assert str(seen[-1][0]).lower().endswith("create")
    stored = await FlowMessage.get_one({"id": fm.id})
    assert stored.text == "", "the persisted row still carries no body"

    fm.is_read = True
    await fm.save()
    assert seen[-1][1] == "a body that must not be persisted" and str(seen[-1][0]).lower().endswith("update")
