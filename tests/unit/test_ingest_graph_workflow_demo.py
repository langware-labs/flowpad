"""The original requirement, proven: a GraphWorkflow receives ingested data.

Everything before this is plumbing. This asserts the thing that was actually
asked for — a real flow, armed from its own ``graph.json``, entering a run
because a DataSource fetched something, with the ingested records reachable from
inside the flow.

It also pins the guidance the storm caps force: a flow subscribes to
``ingest.*.sync.completed`` (one event per cycle, carrying ``changed_ids``) and
fans out itself, rather than to ``ingest.*.item.created`` (one event per record,
capped at 30/min with the excess silently dropped).
"""
from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.graph_workflow import GraphWorkflow
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.graph_workflow_manager import GraphWorkflowManager, graph_workflow_functions
from flow_sdk.ingest.sync import sync_source
from tests.unit._ingest_helpers import local_http_server, serve_fixture

NOW = datetime(2026, 7, 31, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def feed_server():
    with local_http_server(serve_fixture("atom.xml")) as url:
        yield url


async def _until(cond, what: str) -> None:
    for _ in range(600):
        if cond():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"never reached: {what}")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_graph_workflow_receives_ingested_records(feed_server, tmp_path):
    received: list[dict] = []

    @graph_workflow_functions.register("ingest_demo_probe")
    def _probe(event_name, data, ctx):
        received.append({"event": event_name, "data": data})
        return {}

    # ── the demo flow: one function node, armed by a bus subscription ──
    flow = GraphWorkflow(name="ingest-demo", asset_ref=str(tmp_path / "ingest-demo"))
    await flow.save()
    (tmp_path / "ingest-demo").mkdir(parents=True, exist_ok=True)
    (tmp_path / "ingest-demo" / "graph.json").write_text(
        json.dumps(
            {
                "version": 1,
                "id": flow.id,
                "name": "ingest-demo",
                "enabled": True,
                "nodes": [
                    {
                        "id": "on_sync",
                        "node_type": "function",
                        "node_data": {"function": "ingest_demo_probe"},
                    }
                ],
                "edges": [],
                # The recommended lane: one event per cycle, fan out from ids.
                "subscriptions": [
                    {"id": "s1", "pattern": "ingest.*.sync.completed", "node": "on_sync"}
                ],
            }
        ),
        encoding="utf-8",
    )

    manager = GraphWorkflowManager()
    assert await manager.load_flow(flow.id) is not None, "loading the flow arms its subscriptions"

    # ── a DataSource fetches ──
    url = f"{feed_server}/atom"
    account = f"acct-{uuid.uuid4().hex[:8]}"
    src = DataSource(
        id=DataSource.allocate_deterministic_id("rss", account),
        provider="rss",
        kind="datasource.feed.rss",
        account_key=account,
        name="Demo feed",
        config={"feed_urls": [url]},
    )
    await src.save()

    report = await sync_source(src, now=NOW)
    assert report.created == 2

    # ── the flow ran, and can reach the records ──
    await _until(lambda: len(received) >= 1, "the flow never entered a run from ingestion")

    entry = received[0]
    assert entry["event"] == "ingest.rss.sync.completed"
    payload = entry["data"]["data"]
    assert payload["created"] == 2
    assert payload["provider"] == "rss"
    assert len(payload["changed_ids"]) == 2, (
        "sync.completed must carry the ids so a flow can fan out without re-querying"
    )

    for entity_id in payload["changed_ids"]:
        row = await SourceItem.get_one({"id": entity_id})
        assert row is not None, "a changed_id pointed at an entity the flow cannot load"
        assert row.body, "the record reached the flow without its body"

    await _until(lambda: not manager.live_run_ids(), "run finalized")
    # Let the finalize coroutine actually complete before the loop closes —
    # otherwise it is torn down mid-await and logs a pending-task error that
    # would follow this test around the suite.
    for _ in range(20):
        await asyncio.sleep(0)
