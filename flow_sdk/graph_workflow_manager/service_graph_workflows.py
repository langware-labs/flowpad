"""System-scope service flows, seeded at boot (set_service_triggers pattern).

Two flows, written under ``<user_home>/agentic-assets/graph_workflow/`` if absent:

* **mini-analyzer** — a small, fast validation flow: interval Trigger →
  subprocess function counting today's agentic processes via the instance
  REST API (<1s, no LLM) → inline ``flow_echo``. The go-to flow for testing
  the whole machine end-to-end.
* **daily-analysis** — the real 7am usage report as a staged flow: the
  ``builtin_daily_usage_analysis`` Trigger node → subprocess ``analyze``
  function (``flow_sdk.usage_report.graph_workflow_function`` — heavy transcript
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

from flow_sdk.builtin.graph_workflow import GraphWorkflow

logger = logging.getLogger(__name__)

MINI_ANALYZER_SCRIPT = '''\
"""mini-analyzer — demo GraphWorkflowFunction (subprocess): count today's processes.

Runs in its own process with full flow_sdk import access; queries the
instance over REST (ctx.api_base pattern) and emits a `summary` event.
"""
import datetime
import json
import urllib.request


def on_graph_workflow_event(event_name, data, flow_ctx):
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


async def set_service_graph_workflows() -> None:
    """Seed the system flows (idempotent — existing folders are left alone)."""
    try:
        await _seed_mini_analyzer()
    except Exception:
        logger.exception("set_service_graph_workflows: mini-analyzer seed failed")
    try:
        await _seed_daily_analysis()
    except Exception:
        logger.exception("set_service_graph_workflows: daily-analysis seed failed")


async def _find_flow(name: str) -> GraphWorkflow | None:
    """Resolve a seeded flow by name, tolerating duplicate rows.

    Prefer the row whose id matches the filesystem identity resolved by the
    type registry — the same identity the indexer and UI use — else the newest
    row. The resolver includes canonical capsules and read-only legacy fallbacks.
    """
    rows = await GraphWorkflow.get_all({"name": name})
    if not rows:
        return None
    if len(rows) == 1:
        return rows[0]
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    logger.warning("set_service_graph_workflows: %d rows named %r — resolving via capsule", len(rows), name)
    info = SchemaRegistry.get("graph_workflow")
    for row in rows:
        folder = row.folder
        if folder is None or info is None:
            continue
        try:
            if info.extract_id(folder) == row.id:
                return row
        except Exception:
            logger.warning("set_service_graph_workflows: unreadable identity for %s", folder, exc_info=True)
    return max(rows, key=lambda r: str(r.created_date or ""))


async def _get_or_create_flow(name: str) -> tuple[GraphWorkflow | None, bool]:
    """``(flow, created)`` — the existing row when already seeded (created=False)."""
    existing = await _find_flow(name)
    if existing is not None:
        return existing, False
    flow = GraphWorkflow(name=name, scope="system")
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
    logger.info("set_service_graph_workflows: %s mini-analyzer (%s)",
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

The real logic is package-versioned: flow_sdk.usage_report.graph_workflow_function.
Window override: inject event data {"start": iso, "end": iso} to backfill
a specific range; default is yesterday (local time).
"""
from flow_sdk.usage_report.graph_workflow_function import on_graph_workflow_event  # noqa: F401
'''

def _graph_has_retired_shapes(doc: dict) -> bool:
    """True when a seed-owned graph still uses pre-GraphWorkflowFunction spellings.

    The retired set has ONE owner — ``graph_workflow_doc.retired_node_shape`` (the same
    predicate the parse validator raises) — plus one seed-specific addendum:
    the retired daily-analysis monolith callback."""
    from flow_sdk.graph_workflow_manager.graph_workflow_doc import retired_node_shape

    for n in doc.get("nodes") or []:
        if retired_node_shape(n):
            return True
        if (n.get("node_data") or {}).get("program_ref") == "flow_daily_usage_report":
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
    from flow_sdk.api.type_id import TypeId

    want = str(TypeId(type="trigger", id=trigger_id))
    changed = False
    for node in doc.get("nodes") or []:
        nd = node.get("node_data") or {}
        if node.get("node_type") != "trigger":
            continue
        current = str(nd.get("typeid") or "")
        if current and current != want:
            nd["typeid"] = want
            changed = True
    if changed:
        graph_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        logger.info("set_service_graph_workflows: re-pinned %s trigger ref to %s", graph_path.parent.name, want)


async def _seed_daily_analysis() -> None:
    from flow_sdk.builtin.trigger import Trigger

    trigger = await Trigger.get_by_uname("builtin_daily_usage_analysis")
    if trigger is None:
        logger.warning("set_service_graph_workflows: daily usage trigger not found; skipping flow seed")
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
        logger.info("set_service_graph_workflows: migrated daily-analysis (%s) to the staged shape", flow.id)
        return

    (folder / "scripts" / "analyze_usage.py").write_text(DAILY_ANALYZE_SCRIPT, encoding="utf-8")
    graph.write_text(_daily_graph(flow.id, trigger.id), encoding="utf-8")
    logger.info("set_service_graph_workflows: seeded daily-analysis (%s)", flow.id)
