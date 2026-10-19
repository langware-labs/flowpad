"""A stream inbox paged past its oldest held row asks its sources for the page just older — one page,
on demand. The read lands like any other, keeps message time, and never moves the forward position."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.app.actions.flow_message_action import load_older
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver_runtime import DRIVERS
from flow_sdk.ingest.sync import read_older
from flow_sdk.stream_inbox.projection import project_source_item
from tests.utils.fake_source import scripted_provider

pytestmark = [pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

PROVIDER = "olderchat"


async def _source() -> DataSource:
    address = f"{uuid.uuid4().hex[:8]}@chat.test"
    src = DataSource(name=f"older {uuid.uuid4().hex[:6]}", provider=PROVIDER, account_key=address, config={"address": address})
    src.cursor = "forward-position"
    await src.save()
    return src


@pytest.mark.asyncio
async def test_a_backward_read_lands_one_page_in_message_time_and_leaves_the_cursor(monkeypatch):
    now = datetime.now(timezone.utc)
    month_ago = now - timedelta(days=30)  # older than the 7-day window a forward pass reads
    with scripted_provider(PROVIDER, projected=True) as script:
        cls = DRIVERS.get_or_none(PROVIDER).cls
        monkeypatch.setattr(cls, "pages_backward", True)
        asked: list = []
        fetch = cls.fetch

        async def recording(self, cursor=None, *, page_size=None, narrow=None):
            asked.append((cursor, page_size, dict(narrow or {})))
            return await fetch(self, cursor, page_size=page_size, narrow=narrow)

        monkeypatch.setattr(cls, "fetch", recording)
        src = await _source()
        script.push(
            {"external_id": "old-1", "author": "dana@chat.test", "thread_key": "t-old", "body": "old one",
             "occurred_at": (month_ago - timedelta(minutes=2)).isoformat()},
            {"external_id": "old-2", "author": "dana@chat.test", "thread_key": "t-old", "body": "old two",
             "occurred_at": (month_ago - timedelta(minutes=1)).isoformat()},
        )

        fetched, exhausted = await read_older(src, month_ago, 100)

        assert (fetched, exhausted) == (2, True), "a short page means nothing older is left"
        assert asked == [(None, 100, {"before": month_ago})], "one bounded page, no cursor"
        assert (await DataSource.get_by_id(src.id)).cursor == "forward-position", "the forward position is not touched"
        row = await SourceItem.get_one({"data_source_id": str(src.id), "external_id": "old-2"})
        assert row is not None, "the older message landed although it is outside the window"
        await project_source_item(row, source=src, announce=False)
        fm = await FlowMessage.get_one({"source_item_id": str(row.id)})
        conv = await Conversation.get_by_id(fm.conversation_id)
        assert conv.updated_date < month_ago + timedelta(minutes=1), "its conversation sits in message time, on an older page"


@pytest.mark.asyncio
async def test_a_source_that_cannot_read_backwards_is_exhausted_and_not_asked():
    with scripted_provider(PROVIDER, projected=True) as script:
        src = await _source()
        script.push({"external_id": "x", "author": "dana@chat.test", "body": "hi"})
        assert await read_older(src, datetime.now(timezone.utc), 100) == (0, True)
        assert script.fetches == 0
        assert await load_older(before=datetime.now(timezone.utc), page_size=100, source_id=str(src.id)) == {
            "fetched": 0, "exhausted": True,
        }
