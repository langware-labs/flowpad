"""System-scope service flows, seeded at boot (set_service_triggers pattern).

Two flows, written under ``~/.claude/agentic-flows/`` if absent:

* **mini-analyzer** — a small, fast validation flow: interval Trigger →
  pysdk node counting today's agentic processes via the instance REST API
  (<1s, no LLM). The go-to flow for testing the whole machine end-to-end.
* **daily-analysis** — the real 7am usage report as a standard flow: the
  existing ``builtin_daily_usage_analysis`` Trigger node → callback node
  running ``builtin_daily_usage_report``. Seeding ATOMICALLY strips the
  trigger's old direct CALLBACK action so one fire produces exactly one
  report (flow-driven, never double).
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


async def _get_or_create_flow(name: str) -> AgenticFlow | None:
    existing = await AgenticFlow.get_one({"name": name})
    if existing is not None:
        return None  # already seeded — leave the user's edits alone
    flow = AgenticFlow(name=name, scope="system")
    await flow.save()  # scaffolds folder + capsule id
    return flow


async def _seed_mini_analyzer() -> None:
    flow = await _get_or_create_flow("mini-analyzer")
    if flow is None:
        return
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


async def _seed_daily_analysis() -> None:
    from flow_sdk.builtin.trigger import Trigger

    trigger = await Trigger.get_one({"uname": "builtin_daily_usage_analysis"})
    if trigger is None:
        logger.warning("set_service_flows: daily usage trigger not found; skipping flow seed")
        return

    flow = await _get_or_create_flow("daily-analysis")
    if flow is None:
        return

    folder = flow.folder
    assert folder is not None
    nodes = [
        {"id": "trigger-node", "node_type": "trigger", "name": "Daily 7am",
         "node_data": {"typeid": f"trigger-{trigger.id}"}},
        {"id": "report", "node_type": "process_runner", "name": "Usage report",
         "node_data": {"program_kind": "callback", "program_ref": "flow_daily_usage_report"}},
    ]
    edges = [
        {"id": "e1", "from": {"node": "trigger-node", "event": "fired"}, "to": {"node": "report"}},
    ]
    (folder / "graph.json").write_text(_doc(flow.id, "daily-analysis", nodes, edges), encoding="utf-8")
    logger.info("set_service_flows: seeded daily-analysis (%s)", flow.id)
