"""Daily-analysis flow migration — window override, publish callback, seed upgrade.

The heavy analyze stage itself is covered by test_usage_report_analyze.py
(pure ``analyze_usage``); here we test the flow-facing seams added by the
staged migration.
"""
import json
from datetime import datetime, timedelta

import pytest

from flow_sdk.builtin.agentic_flow import AgenticFlow
from flow_sdk.usage_report.flow_node import _window_from_event
from tests.conftest import async_context


def test_window_from_event_override_and_default():
    start, end = _window_from_event(
        {"start": "2026-07-16T00:00:00+03:00", "end": "2026-07-17T00:00:00+03:00"}
    )
    assert start.isoformat() == "2026-07-16T00:00:00+03:00"
    assert end.isoformat() == "2026-07-17T00:00:00+03:00"

    # No override → yesterday local midnight-to-midnight.
    start, end = _window_from_event({})
    assert end - start == timedelta(days=1)
    assert start.hour == start.minute == 0
    today_local = datetime.now().astimezone().date()
    assert end.date() == today_local


@async_context
async def test_publish_callback_posts_feed_entry(tmp_path):
    from flow_sdk.builtin.feed_entry import FeedEntry
    from flow_sdk.flow_manager.envelope import FlowEvent
    from flow_sdk.usage_report.callback import flow_publish_usage_report

    event = FlowEvent(event="report_ready", data={"report_id": "abc-123"},
                      flow_id="f", execution_id="x", source_node="analyze")
    result = await flow_publish_usage_report(event)
    assert result == {"report_id": "abc-123"}

    feeds = await FeedEntry.get_all({})
    assert any((f.data or {}).get("type_id") == "usage_report-abc-123" for f in feeds)

    # Missing report_id is a hard error (the analyze stage always sends one).
    with pytest.raises(ValueError):
        await flow_publish_usage_report(
            FlowEvent(event="report_ready", data={}, flow_id="f",
                      execution_id="x", source_node="analyze"))


@async_context
async def test_seed_migrates_retired_monolith_graph(tmp_path):
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.flow_manager.service_flows import _seed_daily_analysis

    trigger = Trigger(name="Last day usage analysis",
                      uname="builtin_daily_usage_analysis",
                      trigger_type="schedule", sched_trigger_type="cron",
                      expr="0 7 * * *", scope="system")
    await trigger.save()

    folder = tmp_path / "daily-analysis"
    folder.mkdir()
    flow = AgenticFlow(name="daily-analysis", asset_ref=str(folder))
    await flow.save()
    old_graph = {
        "version": 1, "id": flow.id, "name": "daily-analysis", "enabled": True,
        "nodes": [
            {"id": "trigger-node", "node_type": "trigger",
             "node_data": {"typeid": f"trigger-{trigger.id}"}},
            {"id": "report", "node_type": "process_runner",
             "node_data": {"program_kind": "callback",
                           "program_ref": "flow_daily_usage_report"}},
        ],
        "edges": [{"id": "e1", "from": {"node": "trigger-node", "event": "fired"},
                   "to": {"node": "report"}}],
    }
    (folder / "graph.json").write_text(json.dumps(old_graph), encoding="utf-8")

    await _seed_daily_analysis()

    doc = json.loads((folder / "graph.json").read_text(encoding="utf-8"))
    refs = {n["node_data"].get("program_ref") for n in doc["nodes"]
            if n["node_type"] == "process_runner"}
    scripts = {n["node_data"].get("script") for n in doc["nodes"]
               if n["node_type"] == "pysdk"}
    assert refs == {"flow_publish_usage_report"}
    assert scripts == {"scripts/analyze_usage.py"}
    assert (folder / "scripts" / "analyze_usage.py").exists()
    assert doc["id"] == flow.id

    # Re-running is a no-op (already staged — user edits stay untouched).
    (folder / "graph.json").write_text(
        (folder / "graph.json").read_text(encoding="utf-8").replace(
            "Post to feed", "My custom name"), encoding="utf-8")
    await _seed_daily_analysis()
    text = (folder / "graph.json").read_text(encoding="utf-8")
    assert "My custom name" in text

    # A stranded trigger ref (row recreated) is re-pinned to the current row.
    (folder / "graph.json").write_text(
        text.replace(f"trigger-{trigger.id}", "trigger-dead-beef"), encoding="utf-8")
    await _seed_daily_analysis()
    healed = json.loads((folder / "graph.json").read_text(encoding="utf-8"))
    tref = next(n for n in healed["nodes"] if n["node_type"] == "trigger")
    assert tref["node_data"]["typeid"] == f"trigger-{trigger.id}"
    assert "My custom name" in json.dumps(healed)


def test_retired_callbacks_are_gone():
    from flow_sdk.builtin import trigger_callbacks
    from flow_sdk.usage_report import callback as _register  # noqa: F401

    assert trigger_callbacks.get("flow_publish_usage_report") is not None
    assert trigger_callbacks.get("builtin_daily_usage_report") is None
    assert trigger_callbacks.get("flow_daily_usage_report") is None
