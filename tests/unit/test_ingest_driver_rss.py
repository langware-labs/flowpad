"""The RSS/Atom driver, against a real local HTTP server.

A stub client would let the conditional-GET path pass without ever exercising a
304, which is the one behaviour that makes an idle poll free. So these run
against ``http.server`` on a loopback port serving the fixtures: real sockets,
real headers, real ``If-None-Match`` negotiation, no network.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers.rss import RssDriver
from flow_sdk.ingest.health import SourceError, SourceHealth
from tests.unit._ingest_helpers import fixture_bytes, local_http_server, make_data_source

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)
ETAG = 'W/"fixture-v1"'


def _respond(path, headers):
    if path == "/broken":
        return 200, b"this is not xml at all", {"Content-Type": "text/plain"}
    if path == "/missing":
        return 404, b"nope", {"Content-Type": "text/plain"}
    if path == "/boom":
        return 503, b"unavailable", {"Content-Type": "text/plain"}

    name = {"/atom": "atom.xml", "/rss": "rss2.xml"}.get(path)
    if name is None:
        return 404, b"", {"Content-Type": "text/plain"}
    # The conditional-GET negotiation the driver exists to exploit.
    if headers.get("If-None-Match") == ETAG:
        return 304, b"", {"ETag": ETAG}
    return 200, fixture_bytes(name), {"Content-Type": "application/xml", "ETag": ETAG}


@pytest.fixture(scope="module")
def feed_server():
    with local_http_server(_respond) as url:
        yield url


def _source(url: str):
    return make_data_source("rss", name="fixture feed", config={"feed_urls": [url]})


def _view(url: str, *, state=None, window_days: int = 7) -> SegmentCursorView:
    return SegmentCursorView(
        segment_key=url,
        state=state or {},
        window_start=(NOW - timedelta(days=window_days)).isoformat(),
    )


def test_streams_come_from_config():
    src = _source("https://a.test/f")
    src.config = {"feed_urls": ["https://a.test/f", "https://b.test/f"]}
    keys = [s.key for s in RssDriver().segments(src)]
    assert keys == ["https://a.test/f", "https://b.test/f"]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_atom_is_parsed_and_the_window_filters_old_entries(feed_server):
    url = f"{feed_server}/atom"
    result = await RssDriver().fetch(_source(url), _view(url))

    assert result.unchanged is False
    ids = [i.external_id for i in result.items]
    assert len(ids) == 2, "the 2020 entry is outside the 7-day window and must be dropped"
    assert ids[0].startswith("urn:uuid:1225")

    first = result.items[0]
    assert first.title == "First atom entry"
    assert "zebrafish" in first.body
    assert first.author_display == "Ada"
    assert first.permalink == "https://example.test/a/1"
    assert first.occurred_at.startswith("2026-07-30T11:00:00")
    assert result.high_water.startswith("2026-07-30T11:00:00")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_rss2_is_parsed_including_rfc822_dates(feed_server):
    url = f"{feed_server}/rss"
    result = await RssDriver().fetch(_source(url), _view(url))

    assert [i.external_id for i in result.items] == ["rss-item-0001", "rss-item-0002"]
    assert "platypus" in result.items[0].body
    assert result.items[0].occurred_at.startswith("2026-07-30T10:00:00")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_304_is_the_free_no_op_poll(feed_server):
    url = f"{feed_server}/atom"
    driver = RssDriver()

    first = await driver.fetch(_source(url), _view(url))
    assert first.next_state.get("etag") == ETAG, "the ETag must be carried into cursor state"

    second = await driver.fetch(_source(url), _view(url, state=first.next_state))
    assert second.unchanged is True, "the server answered 304 but the driver did not report it"
    assert second.items == []
    assert second.next_state == first.next_state, "state must survive an unchanged poll"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_non_xml_is_a_config_error_not_a_retry_loop(feed_server):
    url = f"{feed_server}/broken"
    with pytest.raises(SourceError) as caught:
        await RssDriver().fetch(_source(url), _view(url))
    assert caught.value.health is SourceHealth.CONFIG_ERROR, (
        "a URL that does not serve XML will not start doing so — retrying is waste"
    )
    assert caught.value.code == "not_a_feed"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_404_is_config_and_503_is_transient(feed_server):
    with pytest.raises(SourceError) as missing:
        await RssDriver().fetch(_source(f"{feed_server}/missing"), _view(f"{feed_server}/missing"))
    assert missing.value.health is SourceHealth.CONFIG_ERROR

    with pytest.raises(SourceError) as boom:
        await RssDriver().fetch(_source(f"{feed_server}/boom"), _view(f"{feed_server}/boom"))
    assert boom.value.health is SourceHealth.TRANSIENT_ERROR
