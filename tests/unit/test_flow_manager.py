"""FlowManager v2 unit tests — flow documents, local-event routing, runs,
scheduler, budgets, pysdk subprocess runner. No LLM spawns (agent nodes are
exercised only up to the budget gate)."""
import asyncio
import json

import pytest

from flow_sdk.builtin import trigger_callbacks
from flow_sdk.builtin.agentic_flow import AgenticFlow
from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun, RunStatus
from flow_sdk.flow_manager import FlowManager, parse_flow_doc
from flow_sdk.flow_manager.envelope import EXTERNAL_SOURCE
from flow_sdk.flow_manager.journal import read_run_journal
from tests.conftest import async_context


async def _until(cond, what: str = "condition") -> None:
    for _ in range(600):
        if cond():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"never reached: {what}")


def _doc(nodes, edges, *, enabled=True, flow_id=""):
    return json.dumps({"version": 1, "id": flow_id, "name": "t", "enabled": enabled,
                       "nodes": nodes, "edges": edges})


async def _make_flow(tmp_path, name, nodes, edges, *, enabled=True) -> AgenticFlow:
    flow = AgenticFlow(name=name, asset_ref=str(tmp_path / name))
    await flow.save()
    (tmp_path / name / "graph.json").write_text(
        _doc(nodes, edges, enabled=enabled, flow_id=flow.id), encoding="utf-8")
    return flow


def _cb(node_id, ref, **nd):
    return {"id": node_id, "node_type": "process_runner",
            "node_data": {"program_kind": "callback", "program_ref": ref, **nd}}


def _edge(eid, src, event, dst):
    return {"id": eid, "from": {"node": src, "event": event}, "to": {"node": dst}}


# ── flow document ─────────────────────────────────────────────────────────────


def test_flow_doc_parse_and_routing_lookups():
    doc = parse_flow_doc(_doc(
        [{"id": "t1", "node_type": "trigger", "node_data": {"typeid": "trigger-abc"}},
         _cb("a", "x"), _cb("b", "y")],
        [_edge("e1", "t1", "fired", "a"), _edge("e2", "a", "done", "b"),
         _edge("e3", "a", "*", "b")],
    ))
    assert doc.trigger_ids() == ["abc"]
    assert [n.id for n in doc.targets_for("t1", "fired")] == ["a"]
    # exact + catch-all both match (b appears twice → both edges deliver)
    assert [n.id for n in doc.targets_for("a", "done")] == ["b", "b"]
    assert [n.id for n in doc.targets_for("a", "anything")] == ["b"]
    assert doc.targets_for("b", "done") == []


def test_flow_doc_validation():
    doc = parse_flow_doc(_doc(
        [{"id": "t1", "node_type": "trigger", "node_data": {}}, _cb("a", "x")],
        [_edge("e1", "t1", "custom", "a"),   # trigger emits only 'fired'
         _edge("e2", "a", "done", "t1"),     # triggers accept no inputs
         _edge("e3", "ghost", "x", "a")],    # unknown source
    ))
    problems = "\n".join(doc.validate_graph())
    assert "only emit 'fired'" in problems
    assert "accept no inputs" in problems
    assert "unknown source" in problems


def test_flow_doc_rejects_bad_version():
    with pytest.raises(ValueError):
        parse_flow_doc('{"version": 99}')


# ── routing + run lifecycle ───────────────────────────────────────────────────


@async_context
async def test_inject_routes_chain_and_run_completes(tmp_path):
    ran: list[str] = []

    @trigger_callbacks.register("v2_first")
    def _first(event):
        ran.append(f"first:{event.event}")
        return {"x": 1}

    @trigger_callbacks.register("v2_second")
    def _second(event):
        ran.append(f"second:{event.data.get('x')}")
        return {}

    flow = await _make_flow(tmp_path, "chain",
        [_cb("a", "v2_first"), _cb("b", "v2_second")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a"), _edge("e2", "a", "done", "b")])

    fm = FlowManager()
    fe = await fm.inject(flow.id, "go", {"hello": 1})
    assert fe is not None
    # first ran on 'go'; its dict return became `done {x:1}` routed to second.
    await _until(lambda: ran == ["first:go", "second:1"], "chain delivered")
    run_id = fe.execution_id
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    row = await AgenticFlowRun.get_by_id(run_id)
    assert row is not None and row.status == RunStatus.COMPLETE.value
    entries = read_run_journal(tmp_path / "chain", run_id)
    kinds = [e["kind"] for e in entries]
    assert kinds[0] == "run_start" and kinds[-1] == "run_end"
    assert "event" in kinds and "node_done" in kinds


@async_context
async def test_catch_all_edge_routes_any_event(tmp_path):
    ran: list[str] = []

    @trigger_callbacks.register("v2_catchall")
    def _cb_fn(event):
        ran.append(event.event)
        return {}

    flow = await _make_flow(tmp_path, "catchall",
        [_cb("a", "v2_catchall")],
        [_edge("e1", EXTERNAL_SOURCE, "*", "a")])

    fm = FlowManager()
    await fm.inject(flow.id, "anything.goes")
    await fm.inject(flow.id, "something.else")
    await _until(lambda: ran == ["anything.goes", "something.else"], "catch-all delivered")


@async_context
async def test_inactive_flow_refuses_injection(tmp_path):
    flow = await _make_flow(tmp_path, "inactive", [_cb("a", "flow_echo")],
                            [_edge("e1", EXTERNAL_SOURCE, "*", "a")], enabled=False)
    fm = FlowManager()
    with pytest.raises(ValueError, match="not active"):
        await fm.inject(flow.id, "go")


@async_context
async def test_target_node_delivers_directly(tmp_path):
    ran: list[str] = []

    @trigger_callbacks.register("v2_direct")
    def _cb_fn(event):
        ran.append(event.event)
        return {}

    # no edges at all — only direct delivery reaches the node
    flow = await _make_flow(tmp_path, "direct", [_cb("a", "v2_direct")], [])
    fm = FlowManager()
    await fm.inject(flow.id, "poke", target_node="a")
    assert ran == ["poke"]


@async_context
async def test_hop_budget_trips_cycle(tmp_path):
    """a.done → a is an infinite loop; the hop budget trips the run."""
    count = {"n": 0}

    @trigger_callbacks.register("v2_cycle")
    def _cb_fn(event):
        count["n"] += 1
        return {}

    flow = await _make_flow(tmp_path, "cycle",
        [_cb("a", "v2_cycle")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a"), _edge("e2", "a", "done", "a")])
    fm = FlowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    row = await AgenticFlowRun.get_by_id(fe.execution_id)
    assert row is not None and row.status == RunStatus.TRIPPED.value
    from flow_sdk.builtin.agentic_flow import DEFAULT_MAX_HOPS

    assert count["n"] <= DEFAULT_MAX_HOPS + 1


# ── scheduler (serial / parallel / merge) ─────────────────────────────────────


@async_context
async def test_serial_node_queues_second_delivery(tmp_path):
    order: list[str] = []
    gate: asyncio.Event = asyncio.Event()

    @trigger_callbacks.register("v2_serial")
    async def _cb_fn(event):
        order.append(f"start:{event.data['n']}")
        if event.data["n"] == 1:
            await gate.wait()
        order.append(f"end:{event.data['n']}")
        return {}

    flow = await _make_flow(tmp_path, "serial",
        [_cb("a", "v2_serial", execution_mode="serial")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = FlowManager()
    first = asyncio.ensure_future(fm.inject(flow.id, "go", {"n": 1}))
    await _until(lambda: order == ["start:1"], "first started")
    second = asyncio.ensure_future(fm.inject(flow.id, "go", {"n": 2}))
    await _until(lambda: fm._node_rt(flow.id, "a").queue, "second queued")
    assert order == ["start:1"]
    gate.set()
    await asyncio.gather(first, second)
    await _until(lambda: order == ["start:1", "end:1", "start:2", "end:2"], "sequential")


@async_context
async def test_merge_identical_absorbs_duplicate(tmp_path):
    runs: list[dict] = []
    gate: asyncio.Event = asyncio.Event()

    @trigger_callbacks.register("v2_merge")
    async def _cb_fn(event):
        runs.append(event.data)
        await gate.wait()
        return {}

    flow = await _make_flow(tmp_path, "merge",
        [_cb("a", "v2_merge", execution_mode="serial", merge_identical=True)],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = FlowManager()
    first = asyncio.ensure_future(fm.inject(flow.id, "go", {"v": 1}))
    await _until(lambda: runs == [{"v": 1}], "first started")
    await fm.inject(flow.id, "go", {"v": 2})
    await fm.inject(flow.id, "go", {"v": 2})  # identical — absorbed
    await fm.inject(flow.id, "go", {"v": 3})
    assert len(fm._node_rt(flow.id, "a").queue) == 2
    gate.set()
    await first
    await _until(lambda: [r["v"] for r in runs] == [1, 2, 3], "distinct payloads ran once")


# ── pysdk runner (real subprocess) ────────────────────────────────────────────


PY_OK = """
def on_flow_event(event_name, data, flow_ctx):
    flow_ctx.log(f"got {event_name} n={data.get('n')}")
"""

PY_BOOM = """
import sys

def on_flow_event(event_name, data, flow_ctx):
    print("about to fail", file=sys.stderr)
    raise RuntimeError("boom from script")
"""


@async_context
async def test_pysdk_node_runs_script_and_captures_stdout(tmp_path):
    flow = await _make_flow(tmp_path, "pyok",
        [{"id": "p", "node_type": "pysdk", "node_data": {"script": "scripts/ok.py"}}],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p")])
    (tmp_path / "pyok" / "scripts" / "ok.py").write_text(PY_OK, encoding="utf-8")

    fm = FlowManager()
    fe = await fm.inject(flow.id, "go", {"n": 7})
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    entries = read_run_journal(tmp_path / "pyok", fe.execution_id)
    done = [e for e in entries if e["kind"] == "node_done"]
    assert done and "got go n=7" in done[0]["stdout"]
    assert done[0]["exit_code"] == 0


@async_context
async def test_pysdk_node_failure_captures_stderr_and_exit_code(tmp_path):
    flow = await _make_flow(tmp_path, "pyboom",
        [{"id": "p", "node_type": "pysdk", "node_data": {"script": "scripts/boom.py"}}],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p")])
    (tmp_path / "pyboom" / "scripts" / "boom.py").write_text(PY_BOOM, encoding="utf-8")

    fm = FlowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    entries = read_run_journal(tmp_path / "pyboom", fe.execution_id)
    errors = [e for e in entries if e["kind"] == "node_error"]
    assert errors and errors[0]["exit_code"] != 0
    assert "boom from script" in errors[0]["stderr"]


@async_context
async def test_pysdk_missing_script_fails_cleanly(tmp_path):
    flow = await _make_flow(tmp_path, "pymissing",
        [{"id": "p", "node_type": "pysdk", "node_data": {"script": "scripts/nope.py"}}],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p")])
    fm = FlowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    entries = read_run_journal(tmp_path / "pymissing", fe.execution_id)
    errors = [e for e in entries if e["kind"] == "node_error"]
    assert errors and errors[0]["exit_code"] == 127


# ── agent budget gate (no real spawn) ─────────────────────────────────────────


@async_context
async def test_agent_process_budget_trips_before_spawn(tmp_path, monkeypatch):
    """max_processes budget refuses further spawns; no AgenticProcess created."""
    from flow_sdk.builtin.agentic_flow import DEFAULT_MAX_PROCESSES
    from flow_sdk.flow_manager import manager as mgr_mod

    flow = await _make_flow(tmp_path, "agentcap",
        [{"id": "a", "node_type": "process_runner",
          "node_data": {"program_kind": "instruction", "program_ref": "hi",
                        "execution_mode": "parallel", "parallel_limit": 99}}],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])

    fm = FlowManager()
    run = await fm._start_run((await fm.load_flow(flow.id)))
    run.processes = DEFAULT_MAX_PROCESSES  # budget exhausted
    node = (await fm.load_flow(flow.id)).doc.node("a")
    rt = fm._node_rt(flow.id, "a")
    rt.active += 1
    run.active += 1
    await fm._spawn_agent(run, node, __import__("flow_sdk.flow_manager.envelope",
                          fromlist=["FlowEvent"]).FlowEvent(
        event="go", flow_id=flow.id, execution_id=run.id), rt)
    assert run.error and "max_processes" in run.error
