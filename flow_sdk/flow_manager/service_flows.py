"""System-scope service flows, seeded at boot (set_service_triggers pattern).

Two flows, written under ``~/.claude/agentic-flows/`` if absent:

* **mini-analyzer** — a small, fast validation flow: interval Trigger →
  subprocess function counting today's agentic processes via the instance
  REST API (<1s, no LLM) → inline ``flow_echo``. The go-to flow for testing
  the whole machine end-to-end.
* **daily-analysis** — the real 7am usage report as a staged flow: the
  ``builtin_daily_usage_analysis`` Trigger node → subprocess ``analyze``
  function (``flow_sdk.usage_report.flow_node`` — heavy transcript
  aggregation + UsageReport persist via REST) → inline
  ``flow_publish_usage_report`` (Home-Feed post). The trigger has no direct
  action (spec ships ``actions=[]``) so one fire produces exactly one report.

Both seeds MIGRATE their own existing graphs in place when they still carry
retired spellings (``pysdk`` / ``process_runner`` / ``program_kind:
callback``) — seed-owned shapes only; user flows fail validation with a
pointed message instead.
"""
from __future__ import annotations

import json
import logging

from flow_sdk.builtin.agentic_flow import AgenticFlow, flows_home_dir

logger = logging.getLogger(__name__)

MINI_ANALYZER_SCRIPT = '''\
"""mini-analyzer — demo FlowFunction (subprocess): count today's processes.

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
    folder = flow.folder if flow else None
    if flow is None or folder is None:
        return
    graph = folder / "graph.json"

    if not created:
        # Migrate a seed-owned graph still on retired spellings; else hands off.
        try:
            doc = json.loads(graph.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not _graph_has_retired_shapes(doc):
            return

    trigger = await _mini_trigger()
    (folder / "scripts").mkdir(exist_ok=True)
    (folder / "scripts" / "mini_analyzer.py").write_text(MINI_ANALYZER_SCRIPT, encoding="utf-8")
    graph.write_text(
        _doc(flow.id, "mini-analyzer", _mini_nodes(trigger.id), _MINI_EDGES), encoding="utf-8")
    logger.info("set_service_flows: %s mini-analyzer (%s)",
                "seeded" if created else "migrated", flow.id)


async def _mini_trigger():
    from flow_sdk.builtin.trigger import Trigger

    trigger = await Trigger.get_one({"name": "Mini analyzer (manual)"})
    if trigger is None:
        trigger = Trigger(name="Mini analyzer (manual)", trigger_type="schedule",
                          sched_trigger_type="interval", expr="24h", scope="system")
        await trigger.save()
        await trigger._register_schedule_job()
    return trigger


def _mini_nodes(trigger_id: str) -> list[dict]:
    return [
        {"id": "trigger-node", "node_type": "trigger", "name": "Manual / daily",
         "node_data": {"typeid": f"trigger-{trigger_id}"}},
        {"id": "analyzer", "node_type": "function", "name": "Mini analyzer",
         "node_data": {"function": "scripts/mini_analyzer.py", "runtime": "subprocess"}},
        {"id": "echo", "node_type": "function", "name": "Log summary",
         "node_data": {"function": "flow_echo", "runtime": "inline"}},
    ]


_MINI_EDGES = [
    {"id": "e1", "from": {"node": "trigger-node", "event": "fired"}, "to": {"node": "analyzer"}},
    {"id": "e2", "from": {"node": "analyzer", "event": "summary"}, "to": {"node": "echo"}},
]


DAILY_ANALYZE_SCRIPT = '''\
"""daily-analysis — analyze stage (thin shim).

The real logic is package-versioned: flow_sdk.usage_report.flow_node.
Window override: inject event data {"start": iso, "end": iso} to backfill
a specific range; default is yesterday (local time).
"""
from flow_sdk.usage_report.flow_node import on_flow_event  # noqa: F401
'''

def _graph_has_retired_shapes(doc: dict) -> bool:
    """True when a seed-owned graph still uses pre-FlowFunction spellings —
    the shapes this seed migrates in place (structural check, no substrings)."""
    for n in doc.get("nodes") or []:
        nd = n.get("node_data") or {}
        if n.get("node_type") in ("pysdk", "process_runner"):
            return True
        if nd.get("program_kind") == "callback":
            return True
        if nd.get("program_ref") == "flow_daily_usage_report":
            return True
    return False


def _daily_graph(flow_id: str, trigger_id: str) -> str:
    nodes = [
        {"id": "trigger-node", "node_type": "trigger", "name": "Daily 7am",
         "node_data": {"typeid": f"trigger-{trigger_id}"}},
        {"id": "analyze", "node_type": "function", "name": "Analyze usage",
         "node_data": {"function": "scripts/analyze_usage.py", "runtime": "subprocess"}},
        {"id": "publish", "node_type": "function", "name": "Post to feed",
         "node_data": {"function": "flow_publish_usage_report", "runtime": "inline"}},
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
        if not _graph_has_retired_shapes(doc):
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
