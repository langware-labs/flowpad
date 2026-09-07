"""Two clocks — EVENT time is first-class, and reindex heals mis-dated rows.

The bug family this fences off (RCA-proven live): the pointer/recency rebuild
stamped every message with ``created_date`` (when WE ingested it), so a
year-old Slack backfill read "11h ago" in the inbox. The fence:

* ``FlowMessage.sent_at`` — projection-owned event time, stamped from the
  item's ``occurred_at`` on every (re)projection;
* TWO read rules, one per question — ``occurred_at = sent_at or created_date``
  drives pointer ts and order (WHERE a message sits), while
  ``event_time = sent_at or updated_date or created_date`` drives conversation
  recency (WHEN it last changed). ``sent_at`` leads both, which is why a
  projected item pins every derivation to its event time;
* convergence — re-projecting a placed item heals a missing/drifted stamp,
  and the reconcile sweep re-projects placed-but-unstamped rows, so a plain
  reindex fixes bad data "as is", today's and any future corruption alike.

House discipline started here: every message-surface test carries a YEAR-OLD
fixture, because live traffic (event time ≈ processing time) mathematically
cannot catch clock conflation.
"""
from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem, SourceItemSpec
from flow_sdk.inbox.projection import project_source_item, reconcile_source
from flow_sdk.utils.serialization import iso_to_utc

YEAR_OLD = "2025-09-01T10:00:00+00:00"


async def _source(**kw) -> DataSource:
    base = dict(
        name="tg", provider="telegram", channel="telegram",
        account_key=f"@b-{uuid.uuid4().hex[:6]}",
    )
    base.update(kw)
    src = DataSource(**base)
    await src.save()
    return src


async def _item(src: DataSource, *, occurred_at: str = YEAR_OLD, thread: str = "1") -> SourceItem:
    item = SourceItem(
        kind="content.message.chat", provider=src.provider,
        data_source_id=str(src.id), segment_key="updates",
        external_id=f"{thread}/{uuid.uuid4().hex[:6]}", thread_key=thread,
        name="old", body="a year old message",
        occurred_at=occurred_at,
        author_external_id="7", author_display="Someone",
    )
    await item.save()
    return item


def _pointers(conv: Conversation) -> list[dict]:
    raw = conv.message_ids
    return json.loads(raw) if isinstance(raw, str) else (raw or [])


async def _conv_for(thread_id: str) -> Conversation:
    th = await MessageThread.get_by_id(thread_id)
    return await Conversation.get_one({"id": th.conversation_id})


class TestEventTimeSurvivesEveryLayer:
    """The year-old fixture, end to end through the REAL entry point."""

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_a_year_old_item_keeps_its_date_at_every_layer(self):
        src = await _source()
        item = await _item(src)
        fm_id, thread_id = await project_source_item(item, source=src, notify=False, announce=False)

        fm = await FlowMessage.get_by_id(fm_id)
        want = iso_to_utc(YEAR_OLD)
        assert iso_to_utc(fm.sent_at) == want, "the row carries EVENT time"
        assert iso_to_utc(fm.occurred_at) == want, "the order/bubble clock pins to it"
        assert iso_to_utc(fm.event_time) == want, "the recency clock pins to it too"

        conv = await _conv_for(thread_id)
        ptrs = _pointers(conv)
        assert ptrs and iso_to_utc(ptrs[0]["ts"]) == want, "the pointer renders it (bubble time)"
        assert iso_to_utc(conv.updated_date) == want, "recency orders the inbox by it"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_conversation_order_is_occurred_at_not_ingest_order(self):
        # Ingest NEWEST first — exactly what providers hand back — and demand
        # the conversation still reads oldest-first by event time.
        src = await _source()
        newer = await _item(src, occurred_at="2026-02-02T00:00:00+00:00", thread="t")
        _, thread_id = await project_source_item(newer, source=src, notify=False, announce=False)
        older = await _item(src, occurred_at="2025-02-02T00:00:00+00:00", thread="t")
        await project_source_item(older, source=src, notify=False, announce=False)

        conv = await _conv_for(thread_id)
        ts = [iso_to_utc(p["ts"]) for p in _pointers(conv)]
        assert ts == sorted(ts), "pointer order is event-time order"
        assert iso_to_utc(conv.updated_date) == max(ts), "recency is the newest EVENT"


class TestReindexHeals:
    """The user's requirement, pinned: the standard re-projection fixes
    mis-dated rows 'as is' — today's legacy shape and any future drift."""

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_reprojecting_a_legacy_row_heals_stamp_pointer_and_recency(self):
        src = await _source()
        item = await _item(src)
        fm_id, thread_id = await project_source_item(item, source=src, notify=False, announce=False)

        # Manufacture today's production shape: a row from before `sent_at`
        # existed. (We cannot run last month's code; a row without the field
        # IS the legacy state, byte for byte.)
        fm = await FlowMessage.get_by_id(fm_id)
        fm.sent_at = None
        await fm.save(notify=False)

        # The standard path, not a migration: re-project the same item.
        await project_source_item(item, source=src, notify=False, announce=False)

        want = iso_to_utc(YEAR_OLD)
        fm = await FlowMessage.get_by_id(fm_id)
        assert iso_to_utc(fm.sent_at) == want, "reindex re-stamps the event time"
        conv = await _conv_for(thread_id)
        assert iso_to_utc(_pointers(conv)[0]["ts"]) == want
        assert iso_to_utc(conv.updated_date) == want

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_the_reconcile_sweep_finds_and_heals_unstamped_rows(self):
        # The sweep runs after EVERY sync — this is what makes "Pull changes"
        # alone fix a mis-dated inbox, with no bespoke script.
        src = await _source()
        item = await _item(src)
        fm_id, _ = await project_source_item(item, source=src, notify=False, announce=False)
        fm = await FlowMessage.get_by_id(fm_id)
        fm.sent_at = None
        await fm.save(notify=False)

        await reconcile_source(str(src.id))

        fm = await FlowMessage.get_by_id(fm_id)
        assert iso_to_utc(fm.sent_at) == iso_to_utc(YEAR_OLD)


class TestTheOtherLanesAreUntouched:
    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_an_authored_message_falls_through_to_its_own_clocks(self):
        # No sent_at → the two clocks part company exactly as intended: an
        # edit still bumps recency, while the message's place stays put.
        fm = FlowMessage(text="typed by a person")
        await fm.save(notify=False)
        assert fm.sent_at is None
        assert iso_to_utc(fm.event_time) == iso_to_utc(fm.updated_date or fm.created_date)
        assert iso_to_utc(fm.occurred_at) == iso_to_utc(fm.created_date)


class TestEdgeNormalization:
    """One canonical dialect at the edge: aware-UTC `+00:00` ISO strings."""

    BASE = dict(data_source_id="d", provider="p", kind="content.message.chat",
                segment_key="s", external_id="e")

    @pytest.mark.parametrize(
        "raw",
        ["2026-01-21T01:02:26Z", "2026-01-21T01:02:26+00:00", "2026-01-21T01:02:26"],
    )
    def test_every_dialect_lands_canonical(self, raw):
        spec = SourceItemSpec(**self.BASE, occurred_at=raw)
        assert spec.occurred_at == "2026-01-21T01:02:26+00:00"

    def test_an_epoch_id_outranks_hand_written_time(self):
        # Slack's ts doubles as id and event time. The agent transport's
        # worker derives occurred_at BY HAND and an LLM's timezone arithmetic
        # drifted by arbitrary half-hours (observed live) — the deterministic
        # epoch wins, and a corrected stamp re-digests as an update, so the
        # next refetch heals the inbox on its own.
        spec = SourceItemSpec(**{
            **self.BASE,
            "provider": "slack",
            "external_id": "1768957346.733449",
            "occurred_at": "2026-01-21T02:32:26+00:00",  # the hallucinated stamp
        })
        assert spec.occurred_at == "2026-01-21T01:02:26.733449+00:00"

    def test_plain_numeric_ids_never_match_the_epoch_rule(self):
        # HackerNews item ids are numeric; Telegram update ids are numeric —
        # only the ten-digit-dot-fraction shape is a timestamp.
        spec = SourceItemSpec(**self.BASE, occurred_at="2026-01-21T02:32:26+00:00")
        assert spec.occurred_at == "2026-01-21T02:32:26+00:00"

    def test_absent_and_garbage_degrade_to_none(self):
        assert SourceItemSpec(**self.BASE, occurred_at=None).occurred_at is None
        assert SourceItemSpec(**self.BASE, occurred_at="not-a-date").occurred_at is None
