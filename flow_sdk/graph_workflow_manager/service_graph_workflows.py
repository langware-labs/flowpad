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


def _doc(flow_id: str, name: str, nodes: list[dict], edges: list[dict], **extra) -> str:
    """The graph.json envelope. `extra` carries the optional blocks
    (`description`, `config`, `subscriptions`) so no seed hand-rolls its own."""
    return (
        json.dumps(
            {"version": 1, "id": flow_id, "name": name, "enabled": True, **extra, "nodes": nodes, "edges": edges},
            indent=2,
        )
        + "\n"
    )


async def set_service_graph_workflows() -> None:
    """Seed the system flows (idempotent — existing folders are left alone).

    Sequential and individually guarded: one seed's failure must not stop the
    others, and they each touch the filesystem, so overlapping them buys little.
    """
    for name, seed in (
        ("mini-analyzer", _seed_mini_analyzer),
        ("daily-analysis", _seed_daily_analysis),
    ):
        try:
            await seed()
        except Exception:
            logger.exception("set_service_graph_workflows: %s seed failed", name)


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
            if info.read_id(folder) == row.id:
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
    # The trigger is upserted on every boot, even when the flow is left alone
    # below — an install seeded under older words gets the current ones.
    trigger = await _mini_trigger()
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

    (folder / "scripts").mkdir(exist_ok=True)
    (folder / "scripts" / "mini_analyzer.py").write_text(MINI_ANALYZER_SCRIPT, encoding="utf-8")
    graph.write_text(_doc(flow.id, "mini-analyzer", _mini_nodes(trigger.id), _MINI_EDGES), encoding="utf-8")
    logger.info("set_service_graph_workflows: %s mini-analyzer (%s)", "seeded" if created else "migrated", flow.id)


#: The mini-analyzer's trigger, seeded like every other built-in: found by its
#: uname, its words kept current from here on every boot.
MINI_TRIGGER_SPEC: dict = {
    "uname": "builtin_mini_analyzer",
    "name": "Daily self-check",
    "description": "A quick daily check that Flowpad is working. It stays on this computer.",
    "trigger_type": "schedule",
    "sched_trigger_type": "interval",
    "expr": "24h",
    # Off until the person turns it on, like every other optional built-in.
    "enabled": False,
}


async def _mini_trigger():
    from flow_sdk.builtin.trigger import Trigger
    from flow_sdk.server.builtin_triggers import _upsert_one

    uname = MINI_TRIGGER_SPEC["uname"]
    existing = await Trigger.get_by_uname(uname)
    if existing is None:
        # Seeded by name before it had a uname: adopt that row, don't mint a second.
        for legacy_name in ("Mini analyzer (manual)", MINI_TRIGGER_SPEC["name"]):
            existing = await Trigger.get_one({"name": legacy_name})
            if existing is not None and not existing.uname:
                # Seeded on before anyone could choose; it starts off like a new one.
                existing.uname, existing.enabled = uname, False
                break
            existing = None
    await _upsert_one(MINI_TRIGGER_SPEC, existing=existing)
    return existing or await Trigger.get_by_uname(uname)


def _mini_nodes(trigger_id: str) -> list[dict]:
    return [
        {
            "id": "trigger-node",
            "node_type": "trigger",
            "name": "Manual / daily",
            "node_data": {"typeid": f"trigger-{trigger_id}"},
        },
        {
            "id": "analyzer",
            "node_type": "function",
            "name": "Mini analyzer",
            "node_data": {"function": "scripts/mini_analyzer.py", "runtime": "subprocess"},
        },
        {
            "id": "echo",
            "node_type": "function",
            "name": "Log summary",
            "node_data": {"function": "flow_echo", "runtime": "inline"},
        },
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
    from flow_sdk.assets.types.graph_workflow_doc import retired_node_shape

    for n in doc.get("nodes") or []:
        if retired_node_shape(n):
            return True
        if (n.get("node_data") or {}).get("program_ref") == "flow_daily_usage_report":
            return True
    return False


def _daily_graph(flow_id: str, trigger_id: str) -> str:
    nodes = [
        {
            "id": "trigger-node",
            "node_type": "trigger",
            "name": "Daily 7am",
            "node_data": {"typeid": f"trigger-{trigger_id}"},
        },
        {
            "id": "analyze",
            "node_type": "function",
            "name": "Analyze usage",
            "node_data": {"function": "scripts/analyze_usage.py", "runtime": "subprocess"},
        },
        {
            "id": "publish",
            "node_type": "function",
            "name": "Post to feed",
            "node_data": {"function": "flow_publish_usage_report", "runtime": "inline"},
        },
    ]
    edges = [
        {"id": "e1", "from": {"node": "trigger-node", "event": "fired"}, "to": {"node": "analyze"}},
        {"id": "e2", "from": {"node": "analyze", "event": "report_ready"}, "to": {"node": "publish"}},
    ]
    return _doc(flow_id, "daily-analysis", nodes, edges)


def _repin_nodes(graph_path, predicate, patch, *, what: str) -> None:
    """Re-point seed-owned node references in a user-owned graph.

    A seeded graph belongs to the user once it exists, but the REFERENCES the
    seed put in it (a builtin trigger row, a shipped SubAgent) are ours: those
    rows can be recreated or minted late, which strands the node — the flow then
    fires nothing, or silently runs the inline fallback. So every boot the
    matching nodes are re-pinned and nothing else is touched.

    ``predicate(node)`` selects the seed-owned nodes; ``patch(node_data)``
    mutates one and returns whether it changed anything. The file is rewritten
    only when something did.
    """
    try:
        doc = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    changed = False
    for node in doc.get("nodes") or []:
        if not predicate(node):
            continue
        node_data = node.get("node_data") or {}
        if patch(node_data):
            node["node_data"] = node_data
            changed = True
    if changed:
        graph_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        logger.info("set_service_graph_workflows: re-pinned %s %s", graph_path.parent.name, what)


def _repin_trigger_nodes(graph_path, trigger_id: str) -> None:
    """Re-point the flow's trigger node(s) at the CURRENT builtin trigger row."""
    from flow_sdk.fs_store.type_id import TypeId

    want = str(TypeId(type="trigger", id=trigger_id))

    def _patch(node_data: dict) -> bool:
        current = str(node_data.get("typeid") or "")
        if not current or current == want:
            return False
        node_data["typeid"] = want
        return True

    _repin_nodes(
        graph_path,
        lambda node: node.get("node_type") == "trigger",
        _patch,
        what=f"trigger ref to {want}",
    )


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
