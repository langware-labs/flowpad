"""System-scope service flows, seeded at boot (set_service_triggers pattern).

Two flows, written under ``~/.claude/agentic-flows/`` if absent:

* **mini-analyzer** — a small, fast validation flow: interval Trigger →
  pysdk node counting today's agentic processes via the instance REST API
  (<1s, no LLM). The go-to flow for testing the whole machine end-to-end.
* **daily-analysis** — the real 7am usage report as a staged flow: the
  ``builtin_daily_usage_analysis`` Trigger node → pysdk ``analyze`` node
  (``flow_sdk.usage_report.flow_node`` — heavy transcript aggregation +
  UsageReport persist via REST) → ``flow_publish_usage_report`` callback
  (Home-Feed post). The trigger has no direct action (spec ships
  ``actions=[]``) so one fire produces exactly one report. Seeding also
  MIGRATES an existing flow that still carries the retired monolith node
  (``flow_daily_usage_report``) to the staged shape.
"""
from __future__ import annotations

import json
import logging

from flow_sdk.builtin.agentic_flow import AgenticFlow, flows_home_dir

logger = logging.getLogger(__name__)

MINI_ANALYZER_SCRIPT = '''\
"""mini-analyzer — pysdk demo node: count today's agentic processes.

Runs in its own process with full flow_sdk import access; queries the
instance over REST (ctx.api_base pattern) and emits a `summary` event.
"""
import datetime
import json
import urllib.request


def on_flow_event(event_name, data, flow_ctx):
    base = flow_ctx._api_base  # instance REST base
    with urllib.request.urlopen(f"{base}/api/v1/graph/agentic_process", timeout=15) as resp:
        rows = json.loads(resp.read()).get("data") or []
    today = datetime.date.today().isoformat()
    todays = [r for r in rows if str(r.get("created_date") or "").startswith(today)]
    summary = {
        "date": today,
        "processes_today": len(todays),
        "processes_total": len(rows),
        "triggered_by": event_name,
    }
    flow_ctx.log(f"mini-analyzer: {summary}")
    flow_ctx.emit_flow_event("summary", summary)
'''


def _doc(flow_id: str, name: str, nodes: list[dict], edges: list[dict]) -> str:
    return json.dumps({"version": 1, "id": flow_id, "name": name, "enabled": True,
                       "nodes": nodes, "edges": edges}, indent=2) + "\n"


async def set_service_flows() -> None:
    """Seed the system flows (idempotent — existing folders are left alone)."""
    try:
        await _seed_mini_analyzer()
    except Exception:
        logger.exception("set_service_flows: mini-analyzer seed failed")
    try:
        await _seed_daily_analysis()
    except Exception:
        logger.exception("set_service_flows: daily-analysis seed failed")


async def _find_flow(name: str) -> AgenticFlow | None:
    """Resolve a seeded flow by name, tolerating duplicate rows.

    Duplicates happen when the folder's ``.flow/id`` capsule gets re-keyed
    (e.g. a concurrent instance's dedup-on-adopt) and the next scan mints a
    second row. Prefer the row whose id matches the CURRENT capsule — that is
    the identity the indexer and the UI resolve — else the newest row.
    """
    rows = await AgenticFlow.get_all({"name": name})
    if not rows:
        return None
    if len(rows) == 1:
        return rows[0]
    from flow_sdk.fs_store.indexer.functions._folder_capsule import read_folder_capsule_id

    logger.warning("set_service_flows: %d rows named %r — resolving via capsule", len(rows), name)
    for row in rows:
        folder = row.folder
        if folder is not None and read_folder_capsule_id(folder) == row.id:
            return row
    return max(rows, key=lambda r: str(r.created_date or ""))


async def _get_or_create_flow(name: str) -> tuple[AgenticFlow | None, bool]:
    """``(flow, created)`` — the existing row when already seeded (created=False)."""
    existing = await _find_flow(name)
    if existing is not None:
        return existing, False
    flow = AgenticFlow(name=name, scope="system")
    await flow.save()  # scaffolds folder + capsule id
    return flow, True


async def _seed_mini_analyzer() -> None:
    flow, created = await _get_or_create_flow("mini-analyzer")
    if not created:
        return  # already seeded — leave the user's edits alone
    assert flow is not None
    from flow_sdk.builtin.trigger import Trigger

    trigger = await Trigger.get_one({"name": "Mini analyzer (manual)"})
    if trigger is None:
        trigger = Trigger(name="Mini analyzer (manual)", trigger_type="schedule",
                          sched_trigger_type="interval", expr="24h", scope="system")
        await trigger.save()
        await trigger._register_schedule_job()

    folder = flow.folder
    assert folder is not None
    (folder / "scripts" / "mini_analyzer.py").write_text(MINI_ANALYZER_SCRIPT, encoding="utf-8")
    nodes = [
        {"id": "trigger-node", "node_type": "trigger", "name": "Manual / daily",
         "node_data": {"typeid": f"trigger-{trigger.id}"}},
        {"id": "analyzer", "node_type": "pysdk", "name": "Mini analyzer",
         "node_data": {"script": "scripts/mini_analyzer.py"}},
        {"id": "echo", "node_type": "process_runner", "name": "Log summary",
         "node_data": {"program_kind": "callback", "program_ref": "flow_echo"}},
    ]
    edges = [
        {"id": "e1", "from": {"node": "trigger-node", "event": "fired"}, "to": {"node": "analyzer"}},
        {"id": "e2", "from": {"node": "analyzer", "event": "summary"}, "to": {"node": "echo"}},
    ]
    (folder / "graph.json").write_text(_doc(flow.id, "mini-analyzer", nodes, edges), encoding="utf-8")
    logger.info("set_service_flows: seeded mini-analyzer (%s)", flow.id)


DAILY_ANALYZE_SCRIPT = '''\
"""daily-analysis — analyze stage (thin shim).

The real logic is package-versioned: flow_sdk.usage_report.flow_node.
Window override: inject event data {"start": iso, "end": iso} to backfill
a specific range; default is yesterday (local time).
"""
from flow_sdk.usage_report.flow_node import on_flow_event  # noqa: F401
'''

# The retired monolith node — its presence in an existing graph marks the
# pre-staged shape this seed migrates away from.
_RETIRED_DAILY_CALLBACK = "flow_daily_usage_report"


def _daily_graph(flow_id: str, trigger_id: str) -> str:
    nodes = [
        {"id": "trigger-node", "node_type": "trigger", "name": "Daily 7am",
         "node_data": {"typeid": f"trigger-{trigger_id}"}},
        {"id": "analyze", "node_type": "pysdk", "name": "Analyze usage",
         "node_data": {"script": "scripts/analyze_usage.py"}},
        {"id": "publish", "node_type": "process_runner", "name": "Post to feed",
         "node_data": {"program_kind": "callback", "program_ref": "flow_publish_usage_report"}},
    ]
    edges = [
        {"id": "e1", "from": {"node": "trigger-node", "event": "fired"}, "to": {"node": "analyze"}},
        {"id": "e2", "from": {"node": "analyze", "event": "report_ready"}, "to": {"node": "publish"}},
    ]
    return _doc(flow_id, "daily-analysis", nodes, edges)


def _repin_trigger_nodes(graph_path, trigger_id: str) -> None:
    """Re-point the flow's trigger node(s) at the CURRENT builtin trigger row.

    Builtin trigger rows can be recreated (fresh DB, uname upsert edge cases),
    which strands the graph's ``trigger-<old-id>`` ref — the flow then never
    fires. The trigger REF is seed-owned (the rest of the graph is the
    user's), so re-pinning it every boot is safe.
    """
    try:
        doc = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    want = f"trigger-{trigger_id}"
    changed = False
    for node in doc.get("nodes") or []:
        nd = node.get("node_data") or {}
        if node.get("node_type") == "trigger" and str(nd.get("typeid") or "").startswith("trigger-") \
                and nd.get("typeid") != want:
            nd["typeid"] = want
            changed = True
    if changed:
        graph_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        logger.info("set_service_flows: re-pinned %s trigger ref to %s", graph_path.parent.name, want)


async def _seed_daily_analysis() -> None:
    from flow_sdk.builtin.trigger import Trigger

    trigger = await Trigger.get_by_uname("builtin_daily_usage_analysis")
    if trigger is None:
        logger.warning("set_service_flows: daily usage trigger not found; skipping flow seed")
        return

    flow, created = await _get_or_create_flow("daily-analysis")
    folder = flow.folder if flow else None
    if flow is None or folder is None:
        return
    graph = folder / "graph.json"

    if not created:
        # Flow exists — leave user edits alone UNLESS it still carries the
        # retired monolith node: that exact shape is ours, migrate it in place.
        # One structural parse decides migrate-vs-repin (no substring scans).
        try:
            doc = json.loads(graph.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        retired = any(
            (n.get("node_data") or {}).get("program_ref") == _RETIRED_DAILY_CALLBACK
            for n in doc.get("nodes") or []
        )
        if not retired:
            _repin_trigger_nodes(graph, trigger.id)
            return
        (folder / "scripts").mkdir(exist_ok=True)
        (folder / "scripts" / "analyze_usage.py").write_text(DAILY_ANALYZE_SCRIPT, encoding="utf-8")
        graph.write_text(_daily_graph(flow.id, trigger.id), encoding="utf-8")
        logger.info("set_service_flows: migrated daily-analysis (%s) to the staged shape", flow.id)
        return

    (folder / "scripts" / "analyze_usage.py").write_text(DAILY_ANALYZE_SCRIPT, encoding="utf-8")
    graph.write_text(_daily_graph(flow.id, trigger.id), encoding="utf-8")
    logger.info("set_service_flows: seeded daily-analysis (%s)", flow.id)
