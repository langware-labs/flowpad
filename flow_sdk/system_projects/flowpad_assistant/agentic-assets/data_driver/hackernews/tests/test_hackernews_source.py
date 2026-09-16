"""The ``hackernews`` data source against a real loopback server: the contract, a changed-ids
feed hydrated and filtered, the free empty poll, and the gate — the same sync loop and ingestor
that serve RSS serve this, with no provider conditional anywhere."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source_cursor import DataSourceCursor
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.sync import sync_source
from flow_sdk.ingest.testing import local_http_server, make_data_source, position
from flow_sdk.sources import CloudOrigin
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.testing import Subject, checks_for

STREAM_KEY = asset_module("hackernews").STREAM_KEY
HackerNewsSource = asset_module("hackernews").HackerNewsSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)
_T = int((NOW - timedelta(hours=1)).timestamp())
ITEMS = {
    101: {"id": 101, "type": "story", "by": "ada", "time": _T, "title": "A story about narwhals",
          "url": "https://example.test/n", "score": 120, "kids": [1, 2, 3]},
    102: {"id": 102, "type": "story", "by": "grace", "time": _T, "title": "Low score story", "text": "quiet", "score": 2},
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
        return _json(200, ITEMS.get(int(path.split("/item/")[1].split(".json")[0])))
    return _json(404, {"error": "not found"})


@pytest.fixture(scope="module")
def hn_server():
    with local_http_server(_respond) as url:
        yield url


@pytest.fixture(autouse=True)
def _reset_state():
    _STATE.update(updates=[101, 102, 103, 104], fail=False)


def _row(base: str, **config):
    return make_data_source("hackernews", kind="datasource.api.hackernews", name="HN", config={"base_url": base, **config})


def _view(state=None):
    return position(segment_key=STREAM_KEY, prior=state or {}, window_start=(NOW - timedelta(days=7)).isoformat())


@pytest.mark.parametrize("check", checks_for(HackerNewsSource), ids=str)
async def test_conformance(check, hn_server):
    await check.run(Subject(
        source=lambda: HackerNewsSource(SourceBinding(config={"base_url": hn_server, "types": ["story", "comment"]})),
        seeded=tuple(CloudOrigin(kind="hackernews", namespace=STREAM_KEY, key=k) for k in ("101", "102", "103")),
    ))


async def test_hacker_news_has_exactly_one_segment(hn_server):
    assert [ref.key for ref in await DataDriver.loaded("hackernews").segments(_row(hn_server))] == [STREAM_KEY]


async def test_changed_ids_are_hydrated_and_filtered(hn_server):
    result = await DataDriver.loaded("hackernews").traverse(_row(hn_server), _view())
    assert sorted(item.external_id for item in result.items) == ["101", "102"], "comments and deleted items are filtered"
    story = next(item for item in result.items if item.external_id == "101")
    assert (story.name, story.author_display) == ("A story about narwhals", "ada")
    assert story.permalink.endswith("id=101") and story.raw["kids"] == [1, 2, 3]


async def test_min_score_filter(hn_server):
    result = await DataDriver.loaded("hackernews").traverse(_row(hn_server, min_score=50), _view())
    assert [item.external_id for item in result.items] == ["101"]


async def test_an_empty_update_set_is_the_free_no_op(hn_server):
    _STATE["updates"] = []
    result = await DataDriver.loaded("hackernews").traverse(_row(hn_server), _view())
    assert result.unchanged and result.items == [] and result.cursor is None


async def test_5xx_is_transient(hn_server):
    _STATE["fail"] = True
    with pytest.raises(Exception) as caught:
        await DataDriver.loaded("hackernews").traverse(_row(hn_server), _view())
    assert classify(caught.value)[0] is SourceHealth.TRANSIENT_ERROR


async def test_a_second_provider_needs_no_change_to_the_shared_pipeline(hn_server):
    src = _row(hn_server)
    await src.save()

    first = await sync_source(src, now=NOW)
    assert first.created == 2, first.as_counts()
    rows = await SourceItem.get_all({"data_source_id": src.id})
    assert {r.external_id for r in rows} == {"101", "102"} and any("narwhals" in (r.name or "") for r in rows)
    assert (await DataSourceCursor.ensure_for(src.id, STREAM_KEY)).health == SourceHealth.OK.value

    # `score` and `kids` ride the volatile echo, so a repeat poll is silent.
    second = await sync_source(src, now=NOW)
    assert (second.created, second.updated, second.unchanged) == (0, 0, 2), second.as_counts()
