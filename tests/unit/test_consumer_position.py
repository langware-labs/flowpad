"""``ConsumerPosition`` and the ingest-order drain it pages with.

The property under test is the one that makes ``ack()`` meaningful: a position never regresses,
survives a restart, and a drain from it is bounded and exact even when rows share a timestamp.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.consumer_position import ConsumerPosition, key_of
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _name() -> str:
    """A consumer name unique to this test: the suite shares one database."""
    return f"w-{mint_uuid()}"


async def _source() -> DataSource:
    src = DataSource(name="feed", provider="rss", config={"feeds": ["http://x/feed"]})
    await src.save()
    return src


async def _item(src: DataSource, n: int, *, created: datetime | None = None) -> SourceItem:
    item = SourceItem(
        data_source_id=str(src.id), segment_key="s", external_id=f"e{n}",
        provider="rss", name=f"item {n}", body=f"body {n}",
    )
    await item.save(notify=False)
    if created is not None:
        # Force the stamp AFTER save: the create hook would otherwise overwrite it.
        item.created_date = created
        await item.save(notify=False)
    return item


# ── the row ──────────────────────────────────────────────────────────────────


async def test_ensure_for_is_a_lookup_not_a_mint():
    src = await _source()
    a = await ConsumerPosition.ensure_for("w", str(src.id))
    b = await ConsumerPosition.ensure_for("w", str(src.id))
    assert a.id == b.id
    assert len(await ConsumerPosition.get_all({"data_source_id": str(src.id)})) == 1


async def test_two_consumers_of_one_source_keep_separate_positions():
    src = await _source()
    item = await _item(src, 1)
    one = await ConsumerPosition.ensure_for("rag", str(src.id))
    two = await ConsumerPosition.ensure_for("triage", str(src.id))
    one.advance_to(item)
    await one.commit()
    assert (await ConsumerPosition.ensure_for("triage", str(src.id))).watermark() is None
    assert two.id != one.id


async def test_an_unnamed_consumer_is_ephemeral():
    """No name, no identity: the row lives in memory and commit() writes nothing."""
    src = await _source()
    item = await _item(src, 1)
    pos = await ConsumerPosition.ensure_for("", str(src.id))
    assert pos.durable is False
    pos.advance_to(item)
    await pos.commit()
    assert pos.is_acked(item)
    assert await ConsumerPosition.get_all({"data_source_id": str(src.id)}) == []


async def test_baseline_makes_a_fresh_listener_yield_arrivals_not_history():
    src = await _source()
    old = await _item(src, 1)
    pos = await ConsumerPosition.ensure_for("w", str(src.id), baseline=old)
    assert pos.is_acked(old)


async def test_advance_never_regresses_and_acking_commits_everything_before():
    src = await _source()
    first, second = await _item(src, 1), await _item(src, 2)
    pos = await ConsumerPosition.ensure_for("w", str(src.id))
    assert pos.advance_to(second) is True
    assert pos.is_acked(first), "acking an item commits everything before it"
    assert pos.advance_to(first) is False, "an older ack after a newer one is a no-op"
    assert pos.watermark() == key_of(second)


async def test_in_flight_is_cleared_by_the_ack_that_covers_it():
    src = await _source()
    item = await _item(src, 1)
    pos = await ConsumerPosition.ensure_for("w", str(src.id))
    pos.mark_in_flight(item)
    assert pos.in_flight_key() == key_of(item)
    pos.advance_to(item)
    assert pos.in_flight_key() is None


async def test_reset_forgets_and_delete_cascades_with_the_source():
    src = await _source()
    item = await _item(src, 1)
    name = _name()
    pos = await ConsumerPosition.ensure_for(name, str(src.id))
    pos.advance_to(item)
    await pos.commit()

    assert await ConsumerPosition.reset_for(name) == 1
    assert (await ConsumerPosition.ensure_for(name, str(src.id))).watermark() is None

    await src.delete()
    assert await ConsumerPosition.get_all({"data_source_id": str(src.id)}) == []


# ── the drain ────────────────────────────────────────────────────────────────


async def test_page_after_walks_the_source_in_ingest_order_and_the_limit_binds():
    src = await _source()
    items = [await _item(src, n) for n in range(7)]

    page = await SourceItem.page_after(str(src.id), None, limit=3)
    assert [i.external_id for i in page] == ["e0", "e1", "e2"]

    page = await SourceItem.page_after(str(src.id), key_of(page[-1]), limit=3)
    assert [i.external_id for i in page] == ["e3", "e4", "e5"]

    page = await SourceItem.page_after(str(src.id), key_of(page[-1]), limit=3)
    assert [i.external_id for i in page] == ["e6"]
    assert await SourceItem.page_after(str(src.id), key_of(items[-1]), limit=3) == []


async def test_page_after_does_not_starve_on_a_timestamp_tie():
    """Rows that share a created_date must all be seen — and none twice."""
    src = await _source()
    stamp = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    tied = [await _item(src, n, created=stamp) for n in range(4)]
    later = await _item(src, 9, created=stamp + timedelta(seconds=1))

    seen: list[str] = []
    after = None
    while True:
        page = await SourceItem.page_after(str(src.id), after, limit=2)
        if not page:
            break
        seen.extend(i.external_id for i in page)
        after = key_of(page[-1])

    assert sorted(seen) == sorted(i.external_id for i in tied + [later])
    assert len(seen) == len(set(seen))


async def test_a_bound_created_date_finds_its_own_row():
    """The aware/naive round-trip: the tie query compares created_date by equality."""
    src = await _source()
    a = await _item(src, 1)
    b = await _item(src, 2, created=a.created_date)  # same stamp, later id — or earlier; either way a tie
    page = await SourceItem.page_after(str(src.id), key_of(min(a, b, key=key_of)), limit=5)
    assert [i.id for i in page] == [max(a, b, key=key_of).id]


async def test_newest_for_is_the_last_ingested_row():
    src = await _source()
    for n in range(3):
        last = await _item(src, n)
    assert (await SourceItem.newest_for(str(src.id))).id == last.id
    assert await SourceItem.newest_for("nope") is None


async def test_the_drain_uses_its_index():
    """`limit` only binds if the query is bounded; an unindexed drain is a type scan per page."""
    from flow_sdk.db.drivers.db_driver import _driver_instances
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    # The suite's driver, not the instance default: the test DB is a tmp file.
    conn = open_sqlite(_driver_instances["sqlite"].config.database, mode="ro")
    try:
        plan = conn.execute(
            "EXPLAIN QUERY PLAN SELECT id FROM entities "
            "WHERE type = 'source_item' AND json_extract(data, '$.data_source_id') = ? "
            "AND created_date > ? ORDER BY created_date, id LIMIT 3",
            ("x", "2026-01-01 00:00:00"),
        ).fetchall()
    finally:
        conn.close()
    text = " ".join(str(row[-1]) for row in plan)
    assert "ix_entities_source_item_by_source_created" in text, text
