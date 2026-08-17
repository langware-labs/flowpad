"""hn-radar: the demo flow's shape, its collector, and its two entry doors.

The point of most of these is that the demo can go wrong in ways that still
"pass" superficially — a graph that parses but whose functions were never
registered, a report lane accidentally wired to the ingestion lane (spawning a
live agent every poll cycle), or a window filter that quietly includes undated
rows. Each of those is asserted directly.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.graph_workflow_manager import graph_workflow_functions, parse_graph_workflow_doc
from flow_sdk.graph_workflow_manager.service_graph_workflows import _hn_radar_graph
from flow_sdk.ingest import flow_functions as hn

FLOW_ID = "11111111-1111-4111-8111-111111111111"


def _doc():
    return parse_graph_workflow_doc(_hn_radar_graph(FLOW_ID))


def test_the_seeded_graph_parses():
    doc = _doc()
    assert doc.name == "hn-radar"
    assert {n.id for n in doc.nodes} == {"tick", "collect", "report"}


def test_the_report_agent_is_not_reachable_from_the_ingestion_lane():
    """THE cost guard.

    `sync.completed` fires once per poll interval. If any edge let it reach the
    agent node, every cycle would spawn a live worker — turning a demo into a
    standing bill. The subscription must terminate at the free inline function.
    """
    doc = _doc()
    subscribed = {s.node for s in doc.subscriptions}
    assert subscribed == {"tick"}, f"subscriptions enter at {subscribed}, expected only 'tick'"

    agents = {n.id for n in doc.nodes if n.node_type == "agent"}
    # Walk everything reachable from the subscription entry point.
    reachable, frontier = set(), list(subscribed)
    while frontier:
        node = frontier.pop()
        for edge in doc.edges:
            if edge.from_.node == node and edge.to_node not in reachable:
                reachable.add(edge.to_node)
                frontier.append(edge.to_node)
    assert not (reachable & agents), (
        f"agent node(s) {reachable & agents} are reachable from the ingestion "
        "subscription — every poll cycle would spawn a live worker"
    )


def test_the_report_lane_is_entered_externally_and_ends_at_the_agent():
    doc = _doc()
    external = [e for e in doc.edges if e.from_.node == "$external"]
    assert [e.to_node for e in external] == ["collect"], (
        "the report lane must be injectable — that is how the demo is fired by hand"
    )
    assert any(e.from_.node == "collect" and e.to_node == "report" for e in doc.edges)


def test_retention_keeps_the_provenance_of_a_report():
    """`_prune_runs` rmtree's the whole run record dir past this count.

    The HTML survives regardless — an agent node writes into the agentic
    process's record dir, not the run's. What the run dir holds is the journal
    and `items.json`: the record of which stories a given report was built from.
    At the default of 5 that evidence is gone almost immediately.
    """
    doc = _doc()
    assert doc.config.retention_runs >= 50, (
        f"retention_runs={doc.config.retention_runs} — a report's inputs and journal "
        "are rmtree'd after that many further runs"
    )


def test_both_functions_are_registered():
    """The trap the poller already hit once: a decorator that never runs because
    nothing imported its module leaves a graph that parses and never executes."""
    registered = {f["name"] for f in graph_workflow_functions.list_registered()}
    assert {"hn_radar_tick", "hn_radar_collect"} <= registered

    for node in _doc().nodes:
        if node.node_type == "function":
            assert node.node_data["function"] in registered, f"node {node.id!r} names an unregistered function"


def test_builtin_triggers_imports_the_flow_functions():
    """Registration only happens if boot actually imports the module."""
    from flow_sdk.server.builtin_triggers import _service_trigger_specs

    _service_trigger_specs()
    registered = {f["name"] for f in graph_workflow_functions.list_registered()}
    assert {"hn_radar_tick", "hn_radar_collect"} <= registered


class _Ctx:
    """The slice of flow_ctx these functions touch."""

    def __init__(self, folder):
        self.output_folder = folder
        self.logged: list[str] = []

    def log(self, message: str) -> None:
        self.logged.append(message)


def test_tick_summarises_a_cycle_without_touching_the_record_store():
    out = hn.hn_radar_tick(
        "ingest.hackernews.sync.completed",
        {
            "tag": "ingest.hackernews.sync.completed",
            "target": "data_source:s-1",
            "data": {
                "provider": "hackernews",
                "source_id": "s-1",
                "created": 3,
                "updated": 1,
                "unchanged": 12,
                "changed_ids": ["a", "b", "c", "d"],
            },
        },
        _Ctx(None),
    )
    assert out == {
        "provider": "hackernews",
        "source_id": "s-1",
        "created": 3,
        "updated": 1,
        "unchanged": 12,
        "changed": 4,
        "tag": "ingest.hackernews.sync.completed",
    }


async def _item(*, external_id: str, occurred_at, score: int, title: str) -> SourceItem:
    source_id = "src-hn"
    row = SourceItem(
        data_source_id=source_id,
        provider="hackernews",
        kind="content.feed.item",
        stream_key="updates",
        external_id=external_id,
        name=title,
        body="https://example.test/x",
        author_display="ada",
        occurred_at=occurred_at.isoformat() if occurred_at else None,
        raw={"score": score},
    )
    await row.save()
    return row


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_collect_windows_by_time_and_ranks_by_score(tmp_path):
    now = datetime.now(timezone.utc)
    tag = uuid.uuid4().hex[:6]
    await _item(external_id=f"{tag}-hot", occurred_at=now - timedelta(hours=2), score=300, title="Hot story")
    await _item(external_id=f"{tag}-mild", occurred_at=now - timedelta(hours=6), score=10, title="Mild story")
    await _item(external_id=f"{tag}-old", occurred_at=now - timedelta(days=4), score=999, title="Old story")
    await _item(external_id=f"{tag}-undated", occurred_at=None, score=500, title="Undated story")

    ctx = _Ctx(tmp_path)
    result = await hn.hn_radar_collect("report", {}, ctx)

    written = json.loads((tmp_path / "items.json").read_text(encoding="utf-8"))
    titles = [i["title"] for i in written["items"]]

    assert "Old story" not in titles, "outside the 24h window"
    assert "Undated story" not in titles, (
        "an item with no occurred_at was included — a 'last 24h' report that "
        "silently carries undated rows is not the report it claims to be"
    )
    hot, mild = titles.index("Hot story"), titles.index("Mild story")
    assert hot < mild, "not ranked by score — `score` lives in `raw`, which is a real column"
    assert result["items_file"].endswith("items.json")
    assert result["empty"] is False
    assert result["window_hours"] == 24


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_zulu_timestamps_are_inside_the_window(tmp_path):
    """Providers emit `...Z`; `fromisoformat` rejects it before 3.11.

    Unfixed, every timestamped row reads as undated, the window returns empty,
    and the report says "no mail" while the records sit in the table — which is
    exactly what a live Gmail run produced.
    """
    now = datetime.now(timezone.utc)
    tag = uuid.uuid4().hex[:6]
    zulu = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    row = await _item(external_id=f"{tag}-zulu", occurred_at=None, score=1, title="Zulu mail")
    row.occurred_at = zulu
    await row.save()

    await hn.hn_radar_collect("report", {"provider": "hackernews"}, _Ctx(tmp_path))
    titles = [i["title"] for i in json.loads((tmp_path / "items.json").read_text(encoding="utf-8"))["items"]]
    assert "Zulu mail" in titles, f"a Z-suffixed timestamp ({zulu}) was treated as undated and dropped"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_collect_reports_empty_rather_than_leaving_the_agent_to_guess(tmp_path):
    """A cold instance is the DEFAULT state of this demo — the HN driver reads
    /v0/updates, so there is nothing to report until the poller has run."""
    ctx = _Ctx(tmp_path)
    result = await hn.hn_radar_collect("report", {"hours": 0}, ctx)
    assert result["empty"] is True
    assert result["count"] == 0
    assert json.loads((tmp_path / "items.json").read_text(encoding="utf-8"))["items"] == []
