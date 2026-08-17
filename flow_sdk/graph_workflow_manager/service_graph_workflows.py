"""System-scope service flows, seeded at boot (set_service_triggers pattern).

Three flows, written under ``<user_home>/agentic-assets/graph_workflow/`` if absent:

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
* **hn-radar** — the ingestion demo: a bus ``subscriptions`` inlet on
  ``ingest.hackernews.sync.completed`` driving a free inline tick, plus a
  separate inject-entered lane (collect → agent) that writes a last-24h HTML
  report. The two lanes are deliberately disjoint — see ``_hn_radar_graph``.

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
        ("hn-radar", _seed_hn_radar),
        ("gmail-radar", _seed_gmail_radar),
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
            if info.mint_entity_id(folder) == row.id:
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
    graph.write_text(_doc(flow.id, "mini-analyzer", _mini_nodes(trigger.id), _MINI_EDGES), encoding="utf-8")
    logger.info("set_service_graph_workflows: %s mini-analyzer (%s)", "seeded" if created else "migrated", flow.id)


async def _mini_trigger():
    from flow_sdk.builtin.trigger import Trigger

    trigger = await Trigger.get_one({"name": "Mini analyzer (manual)"})
    if trigger is None:
        trigger = Trigger(
            name="Mini analyzer (manual)",
            trigger_type="schedule",
            sched_trigger_type="interval",
            expr="24h",
            scope="system",
        )
        await trigger.save()
        await trigger._register_schedule_job()
    return trigger


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
    from flow_sdk.graph_workflow_manager.graph_workflow_doc import retired_node_shape

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


# ── hn-radar ─────────────────────────────────────────────────────────────────

#: `_prune_runs` rmtree's a run's whole record dir past this count. Verified on
#: a live run: the HTML itself is safe either way — an agent node writes into
#: the AGENTIC PROCESS's record dir (`records/agentic_process/<pid>/execution/
#: output/`), which this does not govern. What the run dir holds is the journal
#: and the collect stage's `items.json`, i.e. the evidence of how a given report
#: was produced. Keeping 50 keeps that evidence.
#: A history depth, not a wait/retry budget.
HN_RADAR_RETENTION_RUNS = 50

HN_REPORT_PROMPT = """\
Write a "Hacker News — last 24 hours" report as a single self-contained HTML file.

The event data you were given contains `items_file`: an absolute path to a JSON
file with `{generated_at, window_hours, total_in_window, included, items[]}`,
already filtered to the window and sorted by score descending. Each item has
title, url (the HN discussion), link (the submitted URL), author, score and
occurred_at. Read that file first — do not query the API yourself.

Produce `hacker_news_report.html` in your output folder (the path is given
below). Requirements:
- One self-contained file: inline CSS, no external requests of any kind.
- Lead with a short prose summary of what the day's stories are actually about
  — themes, not a restatement of the list.
- Then the stories, highest score first, each linking to the HN discussion.
- Show the window and generation time, and state `total_in_window` honestly.
- If `empty` is true, say plainly that no items landed in the window and that
  the poller may not have run yet. Do not invent stories, ever.
"""


def _hn_radar_graph(flow_id: str) -> str:
    """Two entry doors, and the split is the point.

    The SUBSCRIPTION lane fires on every ingestion cycle and runs one free
    inline function — that is what makes the canvas visibly tick as global
    events arrive. It deliberately does NOT reach the agent: sync.completed
    fires once per poll interval, so wiring an agent to it would spawn a live
    worker every cycle.

    The REPORT lane is entered on demand — inject `report` (the Signals
    injector, or the flow's own Inject panel) — and only that lane costs money.
    """
    nodes = [
        {
            "id": "tick",
            "node_type": "function",
            "name": "Ingestion pulse",
            "node_data": {"function": "hn_radar_tick", "runtime": "inline"},
        },
        {
            "id": "collect",
            "node_type": "function",
            "name": "Collect last 24h",
            "node_data": {"function": "hn_radar_collect", "runtime": "inline"},
        },
        {
            "id": "report",
            "node_type": "agent",
            "name": "Write the report",
            "node_data": {"prompt": HN_REPORT_PROMPT, "model_size": "sm"},
        },
    ]
    edges = [
        {"id": "e1", "from": {"node": "$external", "event": "report"}, "to": {"node": "collect"}},
        {"id": "e2", "from": {"node": "collect", "event": "done"}, "to": {"node": "report"}},
    ]
    return _doc(
        flow_id,
        "hn-radar",
        nodes,
        edges,
        description=(
            "Hacker News ingestion, watched live; produces a last-24h HTML report "
            "on demand. Inject the `report` event to run it."
        ),
        config={"retention_runs": HN_RADAR_RETENTION_RUNS},
        subscriptions=[
            {
                "id": "s1",
                # The operational lane: one event per cycle carrying counts and
                # changed_ids. The per-item lane is capped at 30/min with the excess
                # silently dropped, and is not what a flow should ride.
                "pattern": "ingest.hackernews.sync.completed",
                "node": "tick",
            }
        ],
    )


async def _seed_hn_radar() -> None:
    flow, created = await _get_or_create_flow("hn-radar")
    folder = flow.folder if flow else None
    if flow is None or folder is None:
        return
    if not created:
        return  # user's flow now — never overwrite an existing graph
    (folder / "graph.json").write_text(_hn_radar_graph(flow.id), encoding="utf-8")
    logger.info("set_service_graph_workflows: seeded hn-radar (%s)", flow.id)


# ── gmail-radar ──────────────────────────────────────────────────────────────

#: The shipped SubAgent the report node runs. Its md is the contract; this is
#: only the name the seed resolves.
EMAIL_SUMMARIZER_SUBAGENT = "email_summarizer"

GMAIL_REPORT_PROMPT = """\
Write a "Gmail — last 24 hours" inbox summary as a single self-contained HTML file.

The event data you were given contains `items_file`: an absolute path to a JSON
file with `{generated_at, window_hours, total_in_window, included, items[]}`,
already filtered to the window. Each item has title (the subject), author
(the sender), occurred_at, url and link. Read that file first — do not query
the API and do not open the mailbox yourself.

Produce `gmail_inbox_summary.html` in your output folder (the path is given
below). Requirements:
- One self-contained file: inline CSS, no external requests of any kind.
- Lead with a short prose read of the day: who wanted what, what looks like it
  needs a reply, what is clearly noise.
- Then the messages, newest first, grouped by sender where that helps.
- Show the window and generation time, and state `total_in_window` honestly.
- If `empty` is true, say plainly that no mail landed in the window and that
  the source may not have polled yet. Never invent a message, a sender or a
  subject.
"""


async def _email_summarizer_ref() -> str:
    """`subagent-<id>` for the shipped Email Summarizer, or "" if unresolved.

    Referencing the SubAgent rather than inlining a prompt is what makes the
    node a *standard agent* on the canvas: its md is the base (model + system
    prompt), the node overrides only what it needs, and a user editing the
    agent changes what the flow runs. The empty fallback keeps a fresh
    instance seedable before the assistant project has been indexed.
    """
    try:
        from flow_sdk.builtin.subagent import SubAgent  # noqa: PLC0415

        row = await SubAgent.get_one({"name": EMAIL_SUMMARIZER_SUBAGENT})
        return str(row.typeid) if row is not None else ""
    except Exception:  # noqa: BLE001 — seeding must never fail on a lookup
        logger.debug("gmail-radar: could not resolve the summarizer subagent", exc_info=True)
        return ""


def _gmail_radar_graph(flow_id: str, subagent_ref: str = "") -> str:
    """The same two-lane shape as hn-radar, over a different provider — which
    is the point: the ingestion spine does not care what fetched the records."""
    nodes = [
        {
            "id": "tick",
            "node_type": "function",
            "name": "Mail pulse",
            "node_data": {"function": "hn_radar_tick", "runtime": "inline"},
        },
        {
            "id": "collect",
            "node_type": "function",
            "name": "Collect last 24h",
            "node_data": {"function": "hn_radar_collect", "runtime": "inline"},
        },
        {
            "id": "report",
            "node_type": "agent",
            "name": "Email Summarizer",
            # The standard agent IS the node: its md carries the model and the
            # system prompt, so nothing is duplicated here. `prompt` rides only as
            # the per-run addendum when the reference cannot be resolved.
            "node_data": (
                {"typeid": subagent_ref} if subagent_ref else {"prompt": GMAIL_REPORT_PROMPT, "model_size": "sm"}
            ),
        },
    ]
    edges = [
        {"id": "e1", "from": {"node": "$external", "event": "report"}, "to": {"node": "collect"}},
        {"id": "e2", "from": {"node": "collect", "event": "done"}, "to": {"node": "report"}},
    ]
    return _doc(
        flow_id,
        "gmail-radar",
        nodes,
        edges,
        description=(
            "Gmail ingested by an agent transport, watched live; produces a "
            "last-24h HTML inbox summary on demand. Inject `report` to run it."
        ),
        config={"retention_runs": HN_RADAR_RETENTION_RUNS},
        subscriptions=[
            {
                "id": "s1",
                "pattern": "ingest.agent.sync.completed",
                "node": "tick",
            }
        ],
    )


def _repin_agent_node(graph_path, node_id: str, subagent_ref: str) -> None:
    """Re-point a seed-owned agent node at the CURRENT SubAgent row.

    Same reasoning as ``_repin_trigger_nodes``: the reference is ours, the rest
    of the graph is the user's. A SubAgent row can be minted after the flow was
    seeded (a fresh instance seeds before the assistant project is indexed), or
    recreated — either way the node is left pointing at nothing, or at the
    inline fallback, and silently runs the wrong thing.
    """
    if not subagent_ref:
        return
    try:
        doc = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    changed = False
    for node in doc.get("nodes") or []:
        if node.get("id") != node_id or node.get("node_type") != "agent":
            continue
        nd = node.get("node_data") or {}
        if nd.get("typeid") == subagent_ref:
            continue
        nd["typeid"] = subagent_ref
        # The inline prompt was only ever the unresolved fallback; leaving it
        # would layer a duplicate system prompt on top of the agent's own.
        nd.pop("prompt", None)
        nd.pop("model_size", None)
        node["node_data"] = nd
        changed = True
    if changed:
        graph_path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        logger.info("set_service_graph_workflows: re-pinned gmail-radar agent node to %s", subagent_ref)


async def _seed_gmail_radar() -> None:
    flow, created = await _get_or_create_flow("gmail-radar")
    folder = flow.folder if flow else None
    if flow is None or folder is None:
        return
    if not created:
        # The graph is the user's now — but the agent REF is seed-owned, so keep
        # it pointing at the shipped Email Summarizer.
        _repin_agent_node(folder / "graph.json", "report", await _email_summarizer_ref())
        return
    ref = await _email_summarizer_ref()
    (folder / "graph.json").write_text(_gmail_radar_graph(flow.id, ref), encoding="utf-8")
    logger.info("set_service_graph_workflows: seeded gmail-radar (%s) agent=%s", flow.id, ref or "(inline fallback)")
