"""The whole spine, end to end, with no mocks.

Real HTTP server, real DataSource + cursor rows, real driver, real ingestor,
real entity writes, real FTS, real event bus. The only thing not exercised is
the public internet.

The second half is the one that matters operationally: **a repeat poll must
produce nothing.** No writes, no events, no re-index. If that ever regresses,
every DataSource becomes a machine for re-firing triggers.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

import flow_sdk.ingest.drivers  # noqa: F401  — registers the shipped drivers
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.ingest.sync import sync_source
from flow_sdk.tags import event_bus
from tests.unit._ingest_helpers import local_http_server, serve_fixture

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def feed_server():
    with local_http_server(serve_fixture("atom.xml")) as url:
        yield url


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_fetch_copy_index_emit_then_a_silent_repeat(feed_server):
    url = f"{feed_server}/atom"
    account = f"acct-{uuid.uuid4().hex[:8]}"
    src = DataSource(
        id=DataSource.allocate_deterministic_id("rss", account),
        provider="rss",
        kind="datasource.feed.rss",
        account_key=account,
        name="Fixture feed",
        config={"feed_urls": [url]},
    )
    await src.save()

    fired: list[str] = []
    unsub = event_bus.on("ingest.*", lambda e: fired.append(e.tag))
    try:
        # ── first run ──────────────────────────────────────────────────────
        first = await sync_source(src, now=NOW)
        assert first.created == 2, f"expected 2 in-window entries, got {first.as_counts()}"

        rows = await SourceItem.get_all({"data_source_id": src.id})
        assert len(rows) == 2
        titles = sorted(r.name for r in rows)
        assert titles == ["First atom entry", "Second atom entry"]

        # indexed: a word that appears only in an entry body
        hits = await SourceItem.search("zebrafish", limit=10)
        assert any(r.id in {h.id for h in hits} for r in rows), "body did not reach FTS"

        # the cursor advanced, and health rolled up
        cursor = await DataSourceCursor.ensure_for(src.id, url)
        assert cursor.health == SourceHealth.OK.value
        assert cursor.high_water.startswith("2026-07-30T11:00:00")

        refreshed = await DataSource.get_one({"id": src.id})
        assert refreshed.health == SourceHealth.OK.value
        assert refreshed.next_poll_at is not None

        # a first run backfills quietly: boundary events only, no per-item storm
        assert "ingest.rss.sync.started" in fired
        assert "ingest.rss.sync.completed" in fired
        assert "ingest.rss.item.created" not in fired, (
            "the first run emitted per-item events; a backfill must report once"
        )

        # ── second run, identical feed ─────────────────────────────────────
        fired.clear()
        stamps = {r.id: r.updated_date for r in rows}

        second = await sync_source(src, now=NOW)
        assert second.created == 0 and second.updated == 0, (
            f"a repeat poll changed something: {second.as_counts()}"
        )
        assert second.unchanged == 2

        after = await SourceItem.get_all({"data_source_id": src.id})
        assert len(after) == 2, "a repeat poll duplicated rows"
        for row in after:
            assert row.updated_date == stamps[row.id], (
                "a repeat poll rewrote an unchanged row — the digest gate is not holding"
            )

        assert [t for t in fired if ".item." in t] == [], (
            "a repeat poll emitted item events; nothing changed, so nothing should fire"
        )
    finally:
        unsub()
