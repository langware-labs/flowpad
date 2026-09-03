"""``docs/snippets/data-sources.md``, section by section, run as written.

Sections are addressed by heading so a snippet inserted above does not re-point a pin. The
names a fence uses but does not define — ``FEED_URL``, ``KEY``, ``WATCHED``, ``DESTINATION``,
``src`` — are what a reader would have in scope, and are supplied through the namespace.
"""

from __future__ import annotations

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — the page's own first fence
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from tests.unit._ingest_helpers import fixture_bytes, local_http_server
from tests.utils.snippets import doc, fence_under, run_fence

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

DOC = "data-sources.md"


def _fresh_feed():
    """The atom fixture, re-dated to now.

    The page says a first run takes only items inside ``window_days``; the fixture's entries
    are months old, so served as-is the snippet's sync would honestly create nothing.
    """
    import re
    from datetime import datetime, timezone

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    body = re.sub(rb"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", stamp.encode(), fixture_bytes("atom.xml"))

    def respond(_path, _headers):
        return 200, body, {"Content-Type": "application/xml"}

    return respond


@pytest.fixture(scope="module")
def feed_server():
    with local_http_server(_fresh_feed()) as url:
        yield url


async def _section(heading: str, ns: dict, *, nth: int = 0) -> dict:
    return await run_fence(fence_under(doc(DOC), heading, nth=nth), ns, filename=f"{DOC} § {heading}")


async def test_1_connect_a_feed_and_sync_it_once(feed_server):
    ns = await _section("1.", {"FEED_URL": f"{feed_server}/atom"})
    # Re-dated to now, all three fixture entries fall inside the window.
    assert ns["outcome"].created == 3
    assert {"First atom entry", "Second atom entry"} <= {r.name for r in ns["rows"]}
    # The contract the prose states: a second sync on an unchanged feed writes nothing.
    again = await ns["src"].sync()
    assert (again.created, again.updated) == (0, 0)


async def test_2_reuse_instead_of_duplicate():
    # §2 assumes §1 is in scope, so DataSource is already imported.
    ns = await _section("2.", {"KEY": "not-a-real-key", "DataSource": DataSource})
    first = ns["src"]
    ns = await _section("2.", {"KEY": "not-a-real-key", "DataSource": DataSource})
    assert ns["src"].id == first.id, "the second run must find the row, not mint a twin"


async def test_3_search_what_landed(feed_server):
    ns = await _section("1.", {"FEED_URL": f"{feed_server}/atom"})
    hits = await SourceItem.search("atom", limit=10)
    assert any(h.data_source_id == str(ns["src"].id) for h in hits)


async def test_4_watch_a_folder_and_mirror_it(tmp_path):
    watched, dest = tmp_path / "watched", tmp_path / "dest"
    watched.mkdir()
    (watched / "note.md").write_text("# Note\n\nhello\n")
    ns = await _section("4.", {"WATCHED": str(watched), "DESTINATION": str(dest)})
    assert (dest / "note.md").exists()
    assert ns["src"].reflect == "copy"


async def test_5_subscribe_to_arrivals(feed_server, capsys):
    ns = await _section("1.", {"FEED_URL": f"{feed_server}/atom"})
    await ns["src"].purge_items()          # so the subscribed sync has something to announce
    await ns["src"].reset_cursors()
    ns = await _section("5.", ns)
    assert "ingest.rss.item.created" in capsys.readouterr().out


async def test_7_operate_a_source(tmp_path):
    watched, dest = tmp_path / "w", tmp_path / "d"
    watched.mkdir()
    ns = await _section("4.", {"WATCHED": str(watched), "DESTINATION": str(dest)})
    src: DataSource = ns["src"]
    await _section("7.", ns)                  # verify, poll_now, replay, reset_cursors, purge_items, delete
    assert await DataSource.get_one({"id": src.id}) is None, "delete() cascades"


async def test_7_read_the_row_first(tmp_path):
    watched, dest = tmp_path / "w", tmp_path / "d"
    watched.mkdir()
    ns = await _section("4.", {"WATCHED": str(watched), "DESTINATION": str(dest)})
    ns = await _section("7.", ns, nth=1)
    assert ns["src"].status in {"new", "setup", "active"}
