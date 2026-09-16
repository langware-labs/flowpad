"""The ``rss`` data source against a real loopback server: the contract, Atom and RSS 2.0
parsing, the window, the free 304, and what each failure needs.

A stub client would let the conditional-GET path pass without ever negotiating a 304 — the one
behaviour that makes an idle poll free — so these are real sockets and real headers.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import local_http_server, make_data_source, position
from flow_sdk.sources import CloudOrigin
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.testing import Subject, checks_for

RssSource = asset_module("rss").RssSource
FIXTURES = Path(__file__).parent / "fixtures"


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)
ETAG = 'W/"fixture-v1"'
ATOM_IDS = tuple(f"urn:uuid:{p}c695-cfb8-4ebb-{q}-80da344efa6a" for p, q in (("1225", "aaaa"), ("2225", "bbbb"), ("3325", "cccc")))


def _respond(path, headers):
    if path == "/broken":
        return 200, b"this is not xml at all", {"Content-Type": "text/plain"}
    if path == "/boom":
        return 503, b"unavailable", {"Content-Type": "text/plain"}
    name = {"/atom": "atom.xml", "/rss": "rss2.xml"}.get(path)
    if name is None:
        return 404, b"nope", {"Content-Type": "text/plain"}
    if headers.get("If-None-Match") == ETAG:
        return 304, b"", {"ETag": ETAG}
    return 200, fixture_bytes(name), {"Content-Type": "application/xml", "ETag": ETAG}


@pytest.fixture(scope="module")
def feed_server():
    with local_http_server(_respond) as url:
        yield url


def _row(*urls: str):
    return make_data_source("rss", name="fixture feed", config={"feed_urls": list(urls)})


def _view(url: str, *, state=None):
    return position(segment_key=url, prior=state or {}, window_start=(NOW - timedelta(days=7)).isoformat())


@pytest.mark.parametrize("check", checks_for(RssSource), ids=str)
async def test_conformance(check, feed_server):
    atom, rss = f"{feed_server}/atom", f"{feed_server}/rss"
    await check.run(Subject(
        source=lambda: RssSource(SourceBinding(config={"feed_urls": [atom, rss]})),
        seeded=tuple(CloudOrigin(kind="rss", namespace=atom, key=entry) for entry in ATOM_IDS),
    ))


async def test_each_feed_url_is_a_segment():
    row = _row("https://a.test/f", "https://b.test/f")
    assert [ref.key for ref in await DataDriver.loaded("rss").segments(row)] == ["https://a.test/f", "https://b.test/f"]


async def test_atom_is_parsed_and_the_window_drops_old_entries(feed_server):
    url = f"{feed_server}/atom"
    result = await DataDriver.loaded("rss").traverse(_row(url), _view(url))
    assert sorted(item.external_id for item in result.items) == list(ATOM_IDS[:2]), "the 2020 entry is outside the window"
    assert [item.external_id for item in result.items] == [ATOM_IDS[1], ATOM_IDS[0]], "records ingest in the order they happened"
    first = next(item for item in result.items if item.external_id == ATOM_IDS[0])
    assert (first.name, first.author_display, first.permalink) == ("First atom entry", "Ada", "https://example.test/a/1")
    assert "zebrafish" in first.body and first.occurred_at.startswith("2026-07-30T11:00:00")
    assert result.high_water.startswith("2026-07-30T11:00:00")


async def test_rss2_is_parsed_including_rfc822_dates(feed_server):
    url = f"{feed_server}/rss"
    result = await DataDriver.loaded("rss").traverse(_row(url), _view(url))
    by_id = {item.external_id: item for item in result.items}
    assert sorted(by_id) == ["rss-item-0001", "rss-item-0002"]
    assert "platypus" in by_id["rss-item-0001"].body and by_id["rss-item-0001"].occurred_at.startswith("2026-07-30T10:00:00")


async def test_a_304_is_the_free_no_op_poll(feed_server):
    url, driver = f"{feed_server}/atom", DataDriver.loaded("rss")
    row = _row(url)
    first = await driver.traverse(row, _view(url))
    assert first.cursor, "the conditional pair must travel as the resume cursor"
    second = await driver.traverse(row, _view(url, state=first))
    assert second.unchanged and second.items == [] and second.cursor == first.cursor


@pytest.mark.parametrize(("path", "health"), [
    ("/broken", SourceHealth.CONFIG_ERROR),
    ("/missing", SourceHealth.CONFIG_ERROR),
    ("/boom", SourceHealth.TRANSIENT_ERROR),
])
async def test_a_failure_classifies_by_what_fixes_it(feed_server, path, health):
    url = f"{feed_server}{path}"
    with pytest.raises(Exception) as caught:
        await DataDriver.loaded("rss").traverse(_row(url), _view(url))
    assert classify(caught.value)[0] is health
