"""An authored source and the shipped builtin must produce the SAME records.

This is the equivalence the data-source asset split is worth having: a user who
writes `data_source.json` + `fetch.py` for a system we already ship must get the
same rows as the Python driver, not merely "something that looks similar".

The comparison key is `content_digest` (`flow_sdk/ingest/digest.py`) — a stable
sha256 over exactly the fields that define a record's identity-as-content. It
already exists, it is what the digest gate compares, and comparing anything
looser would let a real difference through.

Both sides read the SAME bytes off one loopback socket, so a difference can only
come from the driver.
"""
from __future__ import annotations

import stat
from pathlib import Path

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.ingest.digest import content_digest
from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers.rss import RssDriver
from flow_sdk.ingest.drivers.script import driver_for_spec
from tests.unit._ingest_helpers import local_http_server, make_data_source, serve_fixture

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

#: A `fetch.py` that reads an RSS feed with the standard library only and emits
#: the same fields `RssDriver` does. This is what the skill authors, written by
#: hand here so the equivalence claim does not depend on a model.
RSS_MODULE = '''
import json, sys, urllib.request
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree

verb = sys.argv[1]
req = json.load(open(sys.argv[3]))
feeds = req["source"]["config"].get("feed_urls") or []

if verb == "segments":
    print(json.dumps({"segments": [{"key": u, "label": u} for u in feeds]}))
    sys.exit(0)

url = req["cursor"]["segment_key"]
with urllib.request.urlopen(url) as resp:
    tree = ElementTree.fromstring(resp.read())

items = []
for node in tree.iter("item"):
    def text(tag):
        found = node.find(tag)
        return (found.text or "").strip() if found is not None and found.text else ""
    occurred = ""
    if text("pubDate"):
        occurred = parsedate_to_datetime(text("pubDate")).isoformat()
    items.append({
        "external_id": text("guid") or text("link"),
        "title": text("title"),
        "body": text("description"),
        "occurred_at": occurred or None,
        "permalink": text("link") or None,
        "author_display": text("author") or None,
    })
print(json.dumps({"items": items, "state": {"seen": len(items)}}))
'''


def _write_module(folder: Path, body: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "fetch.py"
    path.write_text(body, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class _Spec:
    def __init__(self, folder: Path, name: str):
        self.name = name
        self.runtime = "script"
        self.asset_ref = FSRef(folder)
        # `emits` must match what the builtin stamps, or the digest differs on
        # `kind` alone and the comparison would be vacuous.
        self.traits = {"emits": RssDriver.record_kind}
        self.auth = {}
        self.setup_wiki = ""
        self.id = "spec-rss-authored"


def _digests(items) -> dict[str, str]:
    return {item.external_id: content_digest(item) for item in items}


async def test_an_authored_rss_source_produces_the_same_records_as_the_builtin(tmp_path):
    with local_http_server(serve_fixture("rss2.xml")) as base:
        feed = f"{base}/feed.xml"

        # ── the shipped driver ──
        builtin_source = make_data_source("rss", config={"feed_urls": [feed]})
        builtin = await RssDriver().fetch(
            builtin_source, SegmentCursorView(segment_key=feed, state={}, first_run=True)
        )

        # ── the authored one, same bytes ──
        _write_module(tmp_path / "rss_authored", RSS_MODULE)
        authored_source = make_data_source("rss_authored", config={"feed_urls": [feed]})
        authored = await driver_for_spec(_Spec(tmp_path / "rss_authored", "rss_authored")).fetch(
            authored_source, SegmentCursorView(segment_key=feed, state={}, first_run=True)
        )

    assert _digests(builtin.items), "the builtin produced nothing — the fixture is not being read"
    # Same input, same output. `content_digest` covers kind/title/body/
    # occurred_at/author/permalink/thread_key, so this is the whole record.
    assert _digests(authored.items) == _digests(builtin.items)


async def test_the_authored_source_enumerates_the_same_segments(tmp_path):
    with local_http_server(serve_fixture("rss2.xml")) as base:
        feed = f"{base}/feed.xml"
        _write_module(tmp_path / "rss_authored", RSS_MODULE)
        source = make_data_source("rss_authored", config={"feed_urls": [feed]})

        authored = await driver_for_spec(_Spec(tmp_path / "rss_authored", "rss_authored")).segments(source)
        builtin = await RssDriver().segments(make_data_source("rss", config={"feed_urls": [feed]}))

    assert [s.key for s in authored] == [s.key for s in builtin] == [feed]
