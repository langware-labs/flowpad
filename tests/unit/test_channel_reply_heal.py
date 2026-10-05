"""A channel reply's quote (``reply_to_id``) is linked whichever of the two lands first.

The projection links a reply to its parent by the provider's in-reply-to id. Oldest-first
projection covers the usual order; a parent that arrives AFTER its reply (a backfill page out
of order, a webhook that beat the poll) used to leave the reply unquoted forever. Now placing
the parent heals the replies in its thread.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.legacy_lift import origin_of
from flow_sdk.stream_inbox.projection import project_source_item

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

T0 = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def _records_root(tmp_path, monkeypatch):
    monkeypatch.setattr("flow_sdk.fs_store.record_paths.get_default_records_data_root", lambda: tmp_path)


async def _chat() -> DataSource:
    source = DataSource(
        provider="agent",
        channel="telegram",
        name=f"chat {uuid.uuid4().hex[:8]}",
        account_key=f"bot-{uuid.uuid4().hex[:8]}",
        config={"connector": "telegram", "harness": "claude"},
    )
    await source.save()
    return source


async def _say(source: DataSource, chat: str, ext: str, minutes: int, *, reply_to: str = "") -> str:
    fields = dict(
        id=str(uuid.uuid4()),
        data_source_id=source.id,
        provider="agent",
        kind="content.message.chat",
        external_id=ext,
        thread_key=chat,
        body=f"message {ext}",
        author_external_id="dana",
        reply_to_external_id=reply_to or None,
        occurred_at=(T0 + timedelta(minutes=minutes)).isoformat(),
    )
    # What ingestion stamps: the natural key a reply's parent is found by.
    item = SourceItem(**fields, origin=origin_of(source, SourceItem(**fields)))
    await item.save(notify=False)
    fm_id, _ = await project_source_item(item, source=source, notify=False, announce=False)
    return fm_id


@pytest.mark.asyncio
async def test_a_reply_after_its_parent_quotes_it():
    source, chat = await _chat(), f"chat-{uuid.uuid4().hex[:6]}"
    parent = await _say(source, chat, f"{chat}/1", 0)
    reply = await _say(source, chat, f"{chat}/2", 1, reply_to=f"{chat}/1")

    assert (await FlowMessage.get_one({"id": reply})).reply_to_id == parent


@pytest.mark.asyncio
async def test_a_parent_that_lands_after_its_reply_heals_the_quote():
    source, chat = await _chat(), f"chat-{uuid.uuid4().hex[:6]}"
    reply = await _say(source, chat, f"{chat}/2", 1, reply_to=f"{chat}/1")
    assert (await FlowMessage.get_one({"id": reply})).reply_to_id is None, "nothing to quote yet"

    parent = await _say(source, chat, f"{chat}/1", 0)
    assert (await FlowMessage.get_one({"id": reply})).reply_to_id == parent


@pytest.mark.asyncio
async def test_the_heal_touches_only_replies_to_the_parent():
    source, chat = await _chat(), f"chat-{uuid.uuid4().hex[:6]}"
    other = await _say(source, chat, f"{chat}/9", 2, reply_to=f"{chat}/8")
    plain = await _say(source, chat, f"{chat}/3", 3)
    await _say(source, chat, f"{chat}/1", 0)

    assert (await FlowMessage.get_one({"id": other})).reply_to_id is None
    assert (await FlowMessage.get_one({"id": plain})).reply_to_id is None
