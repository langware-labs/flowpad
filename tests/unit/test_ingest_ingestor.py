"""The ingestion chokepoint: idempotency, the digest gate, ordering, modes.

The ordering test is the important one. ``ingest_item`` promises that by the
time a bus subscriber runs, the row is committed AND searchable — a promise a
refactor could break silently by moving the emit into ``save()``'s notify path
or up into the caller. Nothing else would fail; flows would just start seeing a
missing entity intermittently, under load, in production.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest import IngestItem, IngestMode, ingest_item, ingest_items
from flow_sdk.tags import event_bus


def _item(**kw) -> IngestItem:
    base = dict(
        source_id="ds-ingest-test",
        provider="rss",
        kind="content.feed.item",
        segment_key="https://example.test/feed.xml",
        external_id=f"ext-{uuid.uuid4().hex[:10]}",
        title="A title",
        body="Some prose",
        occurred_at="2026-07-30T10:00:00Z",
    )
    base.update(kw)
    return IngestItem(**base)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_second_identical_ingest_is_unchanged_and_writes_nothing():
    item = _item()

    first = await ingest_item(item)
    assert first.status == "created"

    # Count saves by watching updated_date: an unchanged item must not touch it.
    row = await SourceItem.get_one({"id": first.entity_id})
    stamp_before = row.updated_date

    second = await ingest_item(item)
    assert second.status == "unchanged"
    assert second.entity_id == first.entity_id

    row_after = await SourceItem.get_one({"id": first.entity_id})
    assert row_after.updated_date == stamp_before, (
        "an unchanged item was written anyway — the digest gate is not holding, "
        "so every poll rewrites the corpus and re-fires every trigger"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_changed_body_updates_but_a_volatile_field_does_not():
    external_id = f"ext-{uuid.uuid4().hex[:10]}"

    await ingest_item(_item(external_id=external_id, body="v1"))
    changed = await ingest_item(_item(external_id=external_id, body="v2"))
    assert changed.status == "updated"

    # `raw` is deliberately outside DIGESTED_FIELDS: provider payloads carry
    # counters and rotating URLs that would otherwise flip the digest forever.
    same = await ingest_item(
        _item(external_id=external_id, body="v2", raw={"score": 999, "kids": [1, 2, 3]})
    )
    assert same.status == "unchanged", (
        "a change confined to `raw` moved the digest — volatile provider fields "
        "must not participate in change detection"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_row_is_written_before_the_ingest_event_is_emitted():
    """The record→index→emit order, asserted where it can actually be observed.

    Note the subscribers here are SYNCHRONOUS on purpose. The bus runs sync
    handlers inline inside ``emit_tag`` but schedules coroutine handlers with
    ``ensure_future``, so an async subscriber cannot detect an inverted order —
    it only runs once the loop yields, which ``save()`` does regardless. An
    earlier version of this test used an async handler and passed happily with
    the emit moved above the save; only the inline lane sees the truth.

    ``entity.created`` is emitted from the entity write funnel during ``save``,
    so its position relative to ``ingest.*.item.created`` IS the ordering.
    """
    sequence: list[str] = []
    unsub_entity = event_bus.on("entity.created", lambda e: sequence.append("saved"))
    unsub_ingest = event_bus.on("ingest.*.item.created", lambda e: sequence.append("emitted"))
    try:
        await ingest_item(_item(title="Ordering", body="ordering body"))
    finally:
        unsub_entity()
        unsub_ingest()

    assert "saved" in sequence and "emitted" in sequence
    assert sequence.index("saved") < sequence.index("emitted"), (
        f"got {sequence} — the ingest event was emitted before the row was written, "
        "so a subscriber can observe an entity that does not exist yet"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_subscriber_sees_a_committed_and_searchable_row():
    """The consumer-facing property the ordering exists to produce."""
    import asyncio

    needle = f"zqxorder{uuid.uuid4().hex[:10]}"
    seen: dict = {}

    async def handler(event):
        eid = event.data.get("entity_id")
        seen["row"] = await SourceItem.get_one({"id": eid})
        hits = await SourceItem.search(needle, limit=10)
        seen["searchable"] = any(getattr(h, "id", None) == eid for h in hits)

    unsub = event_bus.on("ingest.*.item.created", handler)
    try:
        outcome = await ingest_item(_item(title="Ordering", body=f"lead {needle} tail"))
        for _ in range(50):
            if "searchable" in seen:
                break
            await asyncio.sleep(0.01)
    finally:
        unsub()

    assert seen.get("row") is not None
    assert seen["row"].id == outcome.entity_id
    assert seen.get("searchable") is True, (
        "the row was committed but was not in FTS when the subscriber ran"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_backfill_emits_nothing_per_item():
    fired: list[str] = []
    unsub = event_bus.on("ingest.*", lambda e: fired.append(e.tag))
    try:
        items = [_item(title=f"item {i}", body=f"body {i}") for i in range(40)]
        report = await ingest_items(items, mode=IngestMode.BACKFILL)
    finally:
        unsub()

    assert report.created == 40
    assert fired == [], (
        f"backfill emitted {len(fired)} per-item events; the GraphWorkflow "
        "subscription cap is 30/min and would silently drop the excess"
    )
    # The caller still learns what moved, without the storm.
    assert len(report.changed_ids) == 40


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_incremental_emits_once_per_changed_item_only():
    fired: list[str] = []
    unsub = event_bus.on("ingest.*", lambda e: fired.append(e.tag))
    try:
        items = [_item(title=f"inc {i}", body=f"body {i}") for i in range(3)]
        await ingest_items(items, mode=IngestMode.INCREMENTAL)
        assert fired == ["ingest.rss.item.created"] * 3

        fired.clear()
        await ingest_items(items, mode=IngestMode.INCREMENTAL)   # identical replay
        assert fired == [], "unchanged items must be silent"
    finally:
        unsub()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_reingest_preserves_local_state():
    """`read`/`starred` are ours, not the provider's — a refresh must not clear them."""
    external_id = f"ext-{uuid.uuid4().hex[:10]}"

    created = await ingest_item(_item(external_id=external_id, body="v1"))
    row = await SourceItem.get_one({"id": created.entity_id})
    row.read = True
    row.starred = True
    await row.save()

    changed = await ingest_item(_item(external_id=external_id, body="v2"))
    assert changed.status == "updated"

    after = await SourceItem.get_one({"id": created.entity_id})
    assert after.body == "v2", "the snapshot half must refresh"
    assert after.read is True and after.starred is True, (
        "local state was clobbered by a re-ingest"
    )
