"""The sync loop: one stream per source, records-before-cursor, and failure as health.

Every pass here runs a SHIPPED data driver against a real outside system: the ``rss`` driver against a
loopback HTTP server this file starts, and the ``folder`` driver over a real ``tmp_path`` tree.

Plus the abstraction gate — a grep, deliberately. The cursor is opaque by contract, and the only way
that contract survives adding providers is if a leak is mechanically detectable. A reviewer will not
notice a provider's cursor key appearing in sync.py; this test will.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.health import SourceHealth
from flow_sdk.ingest.sync import sync_source
from flow_sdk.ingest.testing import local_http_server, make_data_source

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)

#: Provider-private cursor keys. None of these may appear in the engine.
_PROVIDER_STATE_KEYS = ("etag", "last_modified", "last_update_ptr", "oldest_ts", "boundary_ids")


def test_cursor_state_is_opaque_to_the_subsystem():
    """No provider-private cursor key may be read in ``ingest/``: a cursor is the source's own string."""
    root = Path(__file__).resolve().parents[2] / "flow_sdk" / "ingest"
    offenders: list[str] = []

    for path in root.rglob("*.py"):
        code = "\n".join(line for line in path.read_text(encoding="utf-8").splitlines() if not line.lstrip().startswith("#"))
        for key in _PROVIDER_STATE_KEYS:
            if re.search(rf"""["']{key}["']""", code):
                offenders.append(f"{path.relative_to(root.parent.parent)} references {key!r}")

    assert not offenders, "provider-private cursor state leaked into the engine:\n  " + "\n  ".join(offenders)


# ── a real feed ───────────────────────────────────────────────────────────────────────────────────

#: Per feed path: what the server answers next. A test owns its own path, so tests never share a feed.
_FEEDS: dict[str, dict] = {}


def _rss(*entries: tuple[str, str]) -> bytes:
    """A real RSS 2.0 document; each entry is ``(guid, pubDate)``."""
    items = "".join(
        f"<item><guid isPermaLink=\"false\">{guid}</guid><title>{guid}</title>"
        f"<link>https://example.test/{guid}</link><description>body of {guid}</description>"
        f"<pubDate>{when}</pubDate></item>"
        for guid, when in entries
    )
    return f'<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>t</title>{items}</channel></rss>'.encode()


RECENT = "Thu, 30 Jul 2026 10:00:00 GMT"


def _respond(path, headers):
    feed = _FEEDS.get(path)
    if feed is None:
        return 404, b"nope", {"Content-Type": "text/plain"}
    feed["seen"].append(headers.get("If-None-Match"))
    status = feed["statuses"].pop(0) if feed["statuses"] else 200
    if status != 200:
        return status, b"unavailable", {"Content-Type": "text/plain"}
    etag, body = feed["versions"][0] if len(feed["versions"]) == 1 else feed["versions"].pop(0)
    if headers.get("If-None-Match") == etag:
        return 304, b"", {"ETag": etag}
    return 200, body, {"Content-Type": "application/xml", "ETag": etag}


@pytest.fixture(scope="module")
def feed_server():
    with local_http_server(_respond) as url:
        yield url


def _feed(versions, statuses=()) -> str:
    """A fresh feed path: ``versions`` are ``(etag, body)`` served in turn (the last repeats), ``statuses``
    the non-200 answers to give first, in order (200 means serve the next version)."""
    path = f"/feed-{uuid.uuid4().hex[:8]}"
    _FEEDS[path] = {"versions": list(versions), "statuses": list(statuses), "seen": []}
    return path


async def _source(provider: str = "rss", **kw) -> DataSource:
    src = make_data_source(provider, **kw)
    await src.save()
    return src


async def _rss_source(server: str, path: str, **kw) -> DataSource:
    return await _source(config={"feed_url": f"{server}{path}"}, **kw)


async def _reread(src) -> DataSource:
    return await DataSource.get_one({"id": src.id})


async def _stored(src) -> set:
    return {item.name for item in await SourceItem.get_all({"data_source_id": str(src.id)}) or []}


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_good_pass_ingests_then_advances_the_position(feed_server):
    """A pass that read the feed lands its records, then moves the cursor to the feed's resume point."""
    path = _feed([("v1", _rss(("a", RECENT), ("b", RECENT)))])
    src = await _rss_source(feed_server, path)

    report = await sync_source(src, now=NOW)

    assert report.created == 2
    row = await _reread(src)
    assert row.cursor
    assert (row.health, row.consecutive_failures) == (SourceHealth.OK.value, 0)
    assert row.high_water is not None and row.last_synced_at is not None


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_next_pass_starts_from_the_stored_cursor(feed_server):
    """The second pass resumes from the row's stored cursor (the feed sees its ETag come back), and the
    first pass reads from the window floor: an entry older than ``window_days`` is not ingested."""
    old = (NOW - timedelta(days=30)).strftime("%a, %d %b %Y %H:%M:%S GMT")
    path = _feed([("v1", _rss(("fresh", RECENT), ("stale", old)))])
    src = await _rss_source(feed_server, path)

    await sync_source(src, now=NOW)
    await sync_source(await _reread(src), now=NOW + timedelta(minutes=1))

    assert _FEEDS[path]["seen"] == [None, "v1"]
    assert await _stored(src) == {"fresh"}


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_failed_pass_leaves_the_position_and_counts_the_failure(feed_server):
    """A 503 leaves the cursor where the last good pass put it and counts one failure; the next good
    pass advances and resets the count."""
    path = _feed([("v1", _rss(("a", RECENT))), ("v2", _rss(("a", RECENT), ("b", RECENT)))], statuses=[200, 503])
    src = await _rss_source(feed_server, path)

    await sync_source(src, now=NOW)
    row = await _reread(src)
    first = row.cursor
    await sync_source(row, now=NOW + timedelta(minutes=1))
    row = await _reread(src)
    assert row.cursor == first, "a failed pass moved the position — the window it never read is now lost"
    assert (row.health, row.consecutive_failures) == (SourceHealth.TRANSIENT_ERROR.value, 1)
    assert row.error_code

    await sync_source(row, now=NOW + timedelta(minutes=2))
    row = await _reread(src)
    assert row.cursor and row.cursor != first
    assert (row.health, row.consecutive_failures) == (SourceHealth.OK.value, 0)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unchanged_result_carries_the_cursor_and_ingests_nothing(feed_server):
    """A 304 is an unchanged pass: nothing is ingested and the cursor stands."""
    path = _feed([("v1", _rss(("a", RECENT)))])
    src = await _rss_source(feed_server, path)
    await sync_source(src, now=NOW)
    row = await _reread(src)
    kept = row.cursor

    report = await sync_source(row, now=NOW + timedelta(minutes=1))

    assert report.outcomes == []
    row = await _reread(src)
    assert (row.cursor, row.health) == (kept, SourceHealth.OK.value)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_unknown_provider_is_a_config_error_not_a_crash():
    """A row naming no registered driver is parked as a config error, never raised."""
    src = await _source(provider="nosuchprovider")
    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    refreshed = await _reread(src)
    assert refreshed.health == SourceHealth.CONFIG_ERROR.value
    assert refreshed.error_code == "unknown_provider"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_next_poll_is_scheduled_even_when_the_pass_failed(feed_server):
    """A failed pass still reschedules: the cadence is the retry rate."""
    path = _feed([("v1", _rss(("a", RECENT)))], statuses=[503])
    src = await _rss_source(feed_server, path, poll_interval_seconds=120)

    await sync_source(src, now=NOW)
    refreshed = await _reread(src)
    assert refreshed.health == SourceHealth.TRANSIENT_ERROR.value
    assert refreshed.next_poll_at is not None, "a failed run must still reschedule"
    assert refreshed.is_due(NOW) is False
    assert refreshed.is_due(NOW + timedelta(seconds=121)) is True


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_config_error_parks_the_source(feed_server):
    """A 404 is a person's to fix: the source is parked as a config error and polling is refused."""
    src = await _rss_source(feed_server, "/no-such-feed")

    await sync_source(src, now=NOW)

    refreshed = await _reread(src)
    assert refreshed.health == SourceHealth.CONFIG_ERROR.value and refreshed.error_code
    assert refreshed.poll_refusal() != ""


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_source_that_lists_a_window_never_removes(feed_server):
    """A feed lists its recent entries only: an entry that drops off it is not removed from the store."""
    path = _feed([("v1", _rss(("a", RECENT), ("b", RECENT))), ("v2", _rss(("a", RECENT)))])
    src = await _rss_source(feed_server, path)
    assert (await sync_source(src, now=NOW)).created == 2

    report = await sync_source(await _reread(src), now=NOW)

    assert report.removed == 0
    assert await _stored(src) == {"a", "b"}


# ── a real folder ─────────────────────────────────────────────────────────────────────────────────


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_refs_under_record_mode_are_a_config_error_not_a_silent_drop(tmp_path):
    """A reflecting source has no record destination; refused BEFORE traversing, because `reflect` is a
    property of the source — the position never advances past files that were dropped."""
    (tmp_path / "a.md").write_text("a")
    src = await _source(provider="folder", config={"root": str(tmp_path)}, reflect="record")

    report = await sync_source(src, now=NOW)
    assert report.outcomes == []

    refreshed = await _reread(src)
    assert refreshed.manifest == {} and refreshed.high_water is None, "the position advanced past dropped files"
    assert (refreshed.health, refreshed.error_code) == (SourceHealth.CONFIG_ERROR.value, "reflect_mode")
