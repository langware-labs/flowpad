"""The Hacker News driver — and the abstraction gate it exists to test.

RSS proved conditional GET. This proves a changed-ids feed: no ETag, no request
window, a different opaque state key. The point of the last test is not the
driver at all — it is that the sync loop and the ingestor needed **no provider
conditional** to accommodate a second, differently-shaped provider.

Served from a local HTTP server so the JSON shapes, the fan-out over item
fetches, and the error classification are all real.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers.hackernews import STREAM_KEY, HackerNewsDriver
from flow_sdk.ingest.health import SourceError, SourceHealth
from flow_sdk.ingest.sync import sync_source
from tests.unit._ingest_helpers import local_http_server, make_data_source

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)
_T = int((NOW - timedelta(hours=1)).timestamp())

ITEMS = {
    101: {"id": 101, "type": "story", "by": "ada", "time": _T, "title": "A story about narwhals",
          "url": "https://example.test/n", "score": 120, "kids": [1, 2, 3]},
    102: {"id": 102, "type": "story", "by": "grace", "time": _T, "title": "Low score story",
          "text": "quiet", "score": 2},
    103: {"id": 103, "type": "comment", "by": "bob", "time": _T, "text": "a comment"},
    104: {"id": 104, "type": "story", "by": "eve", "time": _T, "title": "Deleted", "deleted": True},
}

_STATE = {"updates": [101, 102, 103, 104], "fail": False}


def _json(status, payload):
    return status, json.dumps(payload).encode(), {"Content-Type": "application/json"}


def _respond(path, _headers):
    if _STATE["fail"]:
        return _json(503, {"error": "unavailable"})
    if path == "/updates.json":
        return _json(200, {"items": _STATE["updates"], "profiles": []})
    if path.startswith("/item/"):
        item_id = int(path.split("/item/")[1].split(".json")[0])
        return _json(200, ITEMS.get(item_id))
    return _json(404, {"error": "not found"})


@pytest.fixture(scope="module")
def hn_server():
    with local_http_server(_respond) as url:
        yield url


@pytest.fixture(autouse=True)
def _reset_state():
    _STATE["updates"] = [101, 102, 103, 104]
    _STATE["fail"] = False
    yield


async def _source(base: str, **config) -> DataSource:
    cfg = {"base_url": base}
    cfg.update(config)
    src = make_data_source(
        "hackernews", kind="datasource.api.hackernews", name="HN", config=cfg
    )
    await src.save()
    return src


def _view(state=None) -> SegmentCursorView:
    return SegmentCursorView(
        segment_key=STREAM_KEY,
        state=state or {},
        window_start=(NOW - timedelta(days=7)).isoformat(),
    )


async def test_hacker_news_has_exactly_one_stream():
    refs = await HackerNewsDriver().segments(None)
    assert [r.key for r in refs] == [STREAM_KEY], (
        "HN has no per-channel partition; one stream also proves the per-stream "
        "machinery tolerates a source that has only one"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_changed_ids_are_hydrated_and_filtered(hn_server):
    src = await _source(hn_server)
    result = await HackerNewsDriver().fetch(src, _view())

    ids = sorted(i.external_id for i in result.items)
    assert ids == ["101", "102"], (
        f"got {ids} — comments and deleted items must be filtered out by type"
    )
    story = next(i for i in result.items if i.external_id == "101")
    assert story.name == "A story about narwhals"
    assert story.author_display == "ada"
    assert story.permalink.endswith("id=101")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_min_score_filter(hn_server):
    src = await _source(hn_server, min_score=50)
    result = await HackerNewsDriver().fetch(src, _view())
    assert [i.external_id for i in result.items] == ["101"]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_the_high_water_pointer_is_the_opaque_state(hn_server):
    src = await _source(hn_server)
    result = await HackerNewsDriver().fetch(src, _view())
    assert result.next_state["last_update_ptr"] == 104, (
        "the pointer records the greatest id seen — a different state shape from "
        "RSS's etag pair, carried by the same cursor"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_an_empty_update_set_is_the_free_no_op(hn_server):
    _STATE["updates"] = []
    src = await _source(hn_server)
    result = await HackerNewsDriver().fetch(src, _view(state={"last_update_ptr": 104}))
    assert result.unchanged is True
    assert result.items == []
    assert result.next_state == {"last_update_ptr": 104}, "state survives an unchanged poll"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_5xx_is_transient(hn_server):
    _STATE["fail"] = True
    src = await _source(hn_server)
    with pytest.raises(SourceError) as caught:
        await HackerNewsDriver().fetch(src, _view())
    assert caught.value.health is SourceHealth.TRANSIENT_ERROR


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_second_provider_needs_no_change_to_the_shared_pipeline(hn_server):
    """THE GATE. The same sync loop and ingestor that serve RSS serve this."""
    src = await _source(hn_server)

    first = await sync_source(src, now=NOW)
    assert first.created == 2, f"expected 2 stories ingested, got {first.as_counts()}"

    rows = await SourceItem.get_all({"data_source_id": src.id})
    assert {r.external_id for r in rows} == {"101", "102"}
    assert any("narwhals" in (r.name or "") for r in rows)

    cursor = await DataSourceCursor.ensure_for(src.id, STREAM_KEY)
    assert cursor.health == SourceHealth.OK.value
    assert cursor.state["last_update_ptr"] == 104

    # And the digest gate holds across providers: `score`/`kids` live in `raw`
    # and move constantly, so a repeat poll must still be silent.
    second = await sync_source(src, now=NOW)
    assert second.created == 0 and second.updated == 0, (
        f"a repeat HN poll changed something: {second.as_counts()}"
    )
    assert second.unchanged == 2
