"""GraphWorkflowManager v2 unit tests — flow documents, local-event routing, runs,
scheduler, budgets, GraphWorkflowFunction runtimes (inline + subprocess), standardized
I/O records, retention, and rerun. No LLM spawns (agent nodes are exercised
only up to the budget gate)."""
import asyncio
import json

import pytest

from flow_sdk.builtin.graph_workflow import GraphWorkflow
from flow_sdk.builtin.graph_workflow_run import GraphWorkflowRun, RunStatus
from flow_sdk.graph_workflow_manager import GraphWorkflowManager, graph_workflow_functions, parse_graph_workflow_doc
from flow_sdk.graph_workflow_manager.envelope import EXTERNAL_SOURCE
from flow_sdk.graph_workflow_manager.journal import read_run_journal
from flow_sdk.graph_workflow_manager.manager import run_record_dir
from tests.conftest import async_context


async def _until(cond, what: str = "condition") -> None:
    for _ in range(600):
        if cond():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"never reached: {what}")


def _doc(nodes, edges, *, enabled=True, flow_id="", config=None):
    payload = {"version": 1, "id": flow_id, "name": "t", "enabled": enabled,
               "nodes": nodes, "edges": edges}
    if config:
        payload["config"] = config
    return json.dumps(payload)


async def _make_flow(tmp_path, name, nodes, edges, *, enabled=True, config=None) -> GraphWorkflow:
    flow = GraphWorkflow(name=name, asset_ref=str(tmp_path / name))
    await flow.save()
    (tmp_path / name / "graph.json").write_text(
        _doc(nodes, edges, enabled=enabled, flow_id=flow.id, config=config), encoding="utf-8")
    return flow


def _fn(node_id, ref, **nd):
    return {"id": node_id, "node_type": "function",
            "node_data": {"function": ref, **nd}}


def _edge(eid, src, event, dst):
    return {"id": eid, "from": {"node": src, "event": event}, "to": {"node": dst}}


# ── flow document ─────────────────────────────────────────────────────────────


def test_graph_workflow_doc_parse_and_routing_lookups():
    doc = parse_graph_workflow_doc(_doc(
        [{"id": "t1", "node_type": "trigger",
          "node_data": {"typeid": "trigger-63e6a325-97be-46f4-a1a5-a9750d4c1d8d"}},
         _fn("a", "x"), _fn("b", "y")],
        [_edge("e1", "t1", "fired", "a"), _edge("e2", "a", "done", "b"),
         _edge("e3", "a", "*", "b")],
    ))
    # Refs parse through the canonical TypeId grammar (garbage refs → ignored).
    assert doc.trigger_ids() == ["63e6a325-97be-46f4-a1a5-a9750d4c1d8d"]
    assert [n.id for n in doc.targets_for("t1", "fired")] == ["a"]
    # exact + catch-all both match (b appears twice → both edges deliver)
    assert [n.id for n in doc.targets_for("a", "done")] == ["b", "b"]
    assert [n.id for n in doc.targets_for("a", "anything")] == ["b"]
    assert doc.targets_for("b", "done") == []


def test_graph_workflow_doc_config_defaults_and_overrides():
    doc = parse_graph_workflow_doc(_doc([], []))
    assert (doc.config.retention_runs, doc.config.max_hops,
            doc.config.max_processes, doc.config.deadline_s) == (5, 16, 10, 600)
    doc = parse_graph_workflow_doc(_doc([], [], config={"retention_runs": 2, "max_hops": 3}))
    assert doc.config.retention_runs == 2
    assert doc.config.max_hops == 3
    assert doc.config.deadline_s == 600  # untouched knobs keep defaults


def test_graph_workflow_doc_rejects_retired_spellings():
    with pytest.raises(ValueError, match='"pysdk" was retired'):
        parse_graph_workflow_doc(_doc([{"id": "p", "node_type": "pysdk", "node_data": {}}], []))
    with pytest.raises(ValueError, match='"process_runner" was renamed'):
        parse_graph_workflow_doc(_doc([{"id": "p", "node_type": "process_runner", "node_data": {}}], []))
    with pytest.raises(ValueError, match='"callback" was retired'):
        parse_graph_workflow_doc(_doc(
            [{"id": "p", "node_type": "agent",
              "node_data": {"program_kind": "callback", "program_ref": "x"}}], []))


def test_graph_workflow_doc_validation():
    doc = parse_graph_workflow_doc(_doc(
        [{"id": "t1", "node_type": "trigger", "node_data": {}},
         _fn("a", "x"),
         _fn("bad", "scripts/x.py", runtime="inline"),
         {"id": "empty", "node_type": "function", "node_data": {}}],
        [_edge("e1", "t1", "custom", "a"),   # trigger emits only 'fired'
         _edge("e2", "a", "done", "t1"),     # triggers accept no inputs
         _edge("e3", "ghost", "x", "a")],    # unknown source
    ))
    problems = "\n".join(doc.validate_graph())
    assert "only emit 'fired'" in problems
    assert "accept no inputs" in problems
    assert "unknown source" in problems
    assert "never runs in the server process" in problems
    assert "need node_data.function" in problems


def test_graph_workflow_doc_function_runtime_defaults():
    doc = parse_graph_workflow_doc(_doc(
        [_fn("a", "flow_echo"), _fn("b", "scripts/x.py"),
         _fn("c", "flow_echo", runtime="subprocess")], []))
    assert doc.node("a").function_runtime() == "inline"
    assert doc.node("b").function_runtime() == "subprocess"
    assert doc.node("c").function_runtime() == "subprocess"


def test_graph_workflow_doc_rejects_bad_version():
    with pytest.raises(ValueError):
        parse_graph_workflow_doc('{"version": 99}')


# ── routing + run lifecycle (inline functions) ────────────────────────────────


@async_context
async def test_inject_routes_chain_and_run_completes(tmp_path):
    ran: list[str] = []

    @graph_workflow_functions.register("v2_first")
    def _first(event_name, data, ctx):
        ran.append(f"first:{event_name}")
        return {"x": 1}

    @graph_workflow_functions.register("v2_second")
    def _second(event_name, data, ctx):
        ran.append(f"second:{data.get('x')}")
        return {}

    flow = await _make_flow(tmp_path, "chain",
        [_fn("a", "v2_first"), _fn("b", "v2_second")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a"), _edge("e2", "a", "done", "b")])

    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go", {"hello": 1})
    assert fe is not None
    # first ran on 'go'; its dict return became `done {x:1}` routed to second.
    await _until(lambda: ran == ["first:go", "second:1"], "chain delivered")
    run_id = fe.execution_id
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    row = await GraphWorkflowRun.get_by_id(run_id)
    assert row is not None and row.status == RunStatus.COMPLETE.value
    entries = read_run_journal(tmp_path / "chain", run_id)
    kinds = [e["kind"] for e in entries]
    assert kinds[0] == "run_start" and kinds[-1] == "run_end"
    assert "event" in kinds and "node_done" in kinds
    # Every execution row carries its seq pointer.
    seqs = [e["execution"]["seq"] for e in entries if e["kind"] == "node_done"]
    assert sorted(seqs) == [1, 2]


@async_context
async def test_run_and_execution_records_are_example_shaped(tmp_path):
    """The standardized I/O records: run input/output + inline execution dirs
    + born-compatible example.json stamps."""

    @graph_workflow_functions.register("v2_records")
    def _rec(event_name, data, ctx):
        ctx.log("hello record")
        return {"answer": data.get("q", 0) * 2}

    flow = await _make_flow(tmp_path, "records",
        [_fn("a", "v2_records")],
        [_edge("e1", EXTERNAL_SOURCE, "ask", "a")])
    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "ask", {"q": 21})
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    run_dir = run_record_dir(fe.execution_id)

    # Run input: the entry event, numbered (Dataset occurrence grammar).
    entry = json.loads((run_dir / "execution" / "input" / "event-1.json").read_text())
    assert entry["event"] == "ask" and entry["data"] == {"q": 21}
    # Run output: `done {answer}` routed nowhere → terminal → flow output.
    out = json.loads((run_dir / "execution" / "output" / "event-1.json").read_text())
    assert out["event"] == "done" and out["data"] == {"answer": 42}
    # Inline execution record: input/event.json + output/result.json + log.
    exec_dir = run_dir / "executions" / "1-a"
    assert json.loads((exec_dir / "input" / "event.json").read_text())["data"] == {"q": 21}
    assert json.loads((exec_dir / "output" / "result.json").read_text()) == {"answer": 42}
    assert "hello record" in (exec_dir / "output" / "log.txt").read_text()
    # Born-compatible examples: deterministic id + provenance source block.
    ex = json.loads((exec_dir / "example.json").read_text())["metadata"]
    assert ex["kind"] == "train"
    src = ex["source"]
    assert src["event_id"] == fe.id  # phase 7: envelope identity in provenance
    assert {k: src[k] for k in ("flow_id", "run_id", "node_id", "seq", "event",
                                "source_node", "hop")} == {
        "flow_id": flow.id, "run_id": fe.execution_id, "node_id": "a",
        "seq": 1, "event": "ask", "source_node": EXTERNAL_SOURCE, "hop": 0}
    run_ex = json.loads((run_dir / "execution" / "example.json").read_text())["metadata"]
    assert run_ex["source"]["node_id"] == "$run"


@async_context
async def test_catch_all_edge_routes_any_event(tmp_path):
    ran: list[str] = []

    @graph_workflow_functions.register("v2_catchall")
    def _fn_impl(event_name, data, ctx):
        ran.append(event_name)
        return {}

    flow = await _make_flow(tmp_path, "catchall",
        [_fn("a", "v2_catchall")],
        [_edge("e1", EXTERNAL_SOURCE, "*", "a")])

    fm = GraphWorkflowManager()
    await fm.inject(flow.id, "anything.goes")
    await fm.inject(flow.id, "something.else")
    await _until(lambda: ran == ["anything.goes", "something.else"], "catch-all delivered")


@async_context
async def test_inactive_flow_refuses_injection(tmp_path):
    flow = await _make_flow(tmp_path, "inactive", [_fn("a", "flow_echo")],
                            [_edge("e1", EXTERNAL_SOURCE, "*", "a")], enabled=False)
    fm = GraphWorkflowManager()
    with pytest.raises(ValueError, match="not active"):
        await fm.inject(flow.id, "go")


@async_context
async def test_target_node_delivers_directly(tmp_path):
    ran: list[str] = []

    @graph_workflow_functions.register("v2_direct")
    def _fn_impl(event_name, data, ctx):
        ran.append(event_name)
        return {}

    # no edges at all — only direct delivery reaches the node
    flow = await _make_flow(tmp_path, "direct", [_fn("a", "v2_direct")], [])
    fm = GraphWorkflowManager()
    await fm.inject(flow.id, "poke", target_node="a")
    assert ran == ["poke"]


@async_context
async def test_hop_budget_trips_cycle_with_config_override(tmp_path):
    """a.done → a is an infinite loop; the flow's OWN max_hops trips the run."""
    count = {"n": 0}

    @graph_workflow_functions.register("v2_cycle")
    def _fn_impl(event_name, data, ctx):
        count["n"] += 1
        return {}

    flow = await _make_flow(tmp_path, "cycle",
        [_fn("a", "v2_cycle")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a"), _edge("e2", "a", "done", "a")],
        config={"max_hops": 4})
    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    row = await GraphWorkflowRun.get_by_id(fe.execution_id)
    assert row is not None and row.status == RunStatus.TRIPPED.value
    assert count["n"] <= 5  # config max_hops(4) + the entry delivery


# ── scheduler (serial / merge) ────────────────────────────────────────────────


@async_context
async def test_serial_node_queues_second_delivery(tmp_path):
    order: list[str] = []
    gate: asyncio.Event = asyncio.Event()

    @graph_workflow_functions.register("v2_serial")
    async def _fn_impl(event_name, data, ctx):
        order.append(f"start:{data['n']}")
        if data["n"] == 1:
            await gate.wait()
        order.append(f"end:{data['n']}")
        return {}

    flow = await _make_flow(tmp_path, "serial",
        [_fn("a", "v2_serial", execution_mode="serial")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = GraphWorkflowManager()
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

    @graph_workflow_functions.register("v2_merge")
    async def _fn_impl(event_name, data, ctx):
        runs.append(data)
        await gate.wait()
        return {}

    flow = await _make_flow(tmp_path, "merge",
        [_fn("a", "v2_merge", execution_mode="serial", merge_identical=True)],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = GraphWorkflowManager()
    first = asyncio.ensure_future(fm.inject(flow.id, "go", {"v": 1}))
    await _until(lambda: runs == [{"v": 1}], "first started")
    await fm.inject(flow.id, "go", {"v": 2})
    await fm.inject(flow.id, "go", {"v": 2})  # identical — absorbed
    await fm.inject(flow.id, "go", {"v": 3})
    assert len(fm._node_rt(flow.id, "a").queue) == 2
    gate.set()
    await first
    await _until(lambda: [r["v"] for r in runs] == [1, 2, 3], "distinct payloads ran once")


# ── subprocess functions (real subprocess + hidden process rows) ──────────────


PY_OK = """
def on_graph_workflow_event(event_name, data, flow_ctx):
    flow_ctx.log(f"got {event_name} n={data.get('n')}")
    (flow_ctx.output_folder / "artifact.txt").write_text("made this")
    return {"doubled": data.get("n", 0) * 2}
"""

PY_BOOM = """
import sys

def on_graph_workflow_event(event_name, data, flow_ctx):
    print("about to fail", file=sys.stderr)
    raise RuntimeError("boom from script")
"""


@async_context
async def test_subprocess_function_records_and_auto_done(tmp_path):
    """Script subprocess: hidden AgenticProcess row with its OWN standard
    folders, full stdio files, and the uniform dict-return auto-`done`."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    chained: list[dict] = []

    @graph_workflow_functions.register("v2_after_sub")
    def _after(event_name, data, ctx):
        chained.append(data)
        return {}

    flow = await _make_flow(tmp_path, "subok",
        [_fn("p", "scripts/ok.py", runtime="subprocess"), _fn("q", "v2_after_sub")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p"), _edge("e2", "p", "done", "q")])
    (tmp_path / "subok" / "scripts" / "ok.py").write_text(PY_OK, encoding="utf-8")

    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go", {"n": 7})
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    # Uniform return semantics: the subprocess handler's dict chained onward.
    await _until(lambda: chained == [{"doubled": 14}], "auto-done chained")

    entries = read_run_journal(tmp_path / "subok", fe.execution_id)
    done = [e for e in entries if e["kind"] == "node_done" and e["node"] == "p"]
    assert done and done[0]["exit_code"] == 0
    assert "got go n=7" in done[0]["stdout"]
    proc_id = done[0]["process_id"]

    proc = await AgenticProcess.get_by_id(proc_id)
    assert proc is not None and proc.visible is False and proc.exit_code == 0
    exec_base = proc._record_dir() / "execution"
    assert json.loads((exec_base / "input" / "event.json").read_text())["data"] == {"n": 7}
    assert "got go n=7" in (exec_base / "output" / "stdout.log").read_text()
    assert (exec_base / "output" / "artifact.txt").read_text() == "made this"
    ex = json.loads((exec_base / "example.json").read_text())["metadata"]
    assert ex["source"]["process_id"] == proc_id


@async_context
async def test_subprocess_function_failure_captures_stderr_and_exit_code(tmp_path):
    flow = await _make_flow(tmp_path, "subboom",
        [_fn("p", "scripts/boom.py", runtime="subprocess")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p")])
    (tmp_path / "subboom" / "scripts" / "boom.py").write_text(PY_BOOM, encoding="utf-8")

    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    entries = read_run_journal(tmp_path / "subboom", fe.execution_id)
    errors = [e for e in entries if e["kind"] == "node_error"]
    assert errors and errors[0]["exit_code"] != 0
    assert "boom from script" in errors[0]["stderr"]


@async_context
async def test_subprocess_registry_name_resolves(tmp_path):
    """A REGISTRY name in a subprocess node: the runner imports flow_sdk and
    resolves it — promoting a library function to isolation is config-only."""
    flow = await _make_flow(tmp_path, "subreg",
        [_fn("p", "flow_relay", runtime="subprocess")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p")])
    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go", {"hops": 1})
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    entries = read_run_journal(tmp_path / "subreg", fe.execution_id)
    done = [e for e in entries if e["kind"] == "node_done"]
    assert done and done[0]["exit_code"] == 0
    # flow_relay's return chained as `done {hops: 2}` → terminal → run output.
    out = json.loads((run_record_dir(fe.execution_id) / "execution" / "output"
                      / "event-1.json").read_text())
    assert out["data"]["hops"] == 2


@async_context
async def test_subprocess_missing_script_fails_cleanly(tmp_path):
    flow = await _make_flow(tmp_path, "submissing",
        [_fn("p", "scripts/nope.py", runtime="subprocess")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p")])
    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    entries = read_run_journal(tmp_path / "submissing", fe.execution_id)
    errors = [e for e in entries if e["kind"] == "node_error"]
    assert errors and errors[0]["exit_code"] == 127


# ── rerun ─────────────────────────────────────────────────────────────────────


@async_context
async def test_replay_run_reinjects_recorded_entry(tmp_path):
    ran: list[dict] = []

    @graph_workflow_functions.register("v2_replayed")
    def _fn_impl(event_name, data, ctx):
        ran.append(dict(data))
        return {}

    flow = await _make_flow(tmp_path, "replayflow",
        [_fn("a", "v2_replayed")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go", {"seed": 9})
    await _until(lambda: not fm.live_run_ids(), "first run finalized")

    new_run = await fm.replay_run(flow.id, fe.execution_id)
    assert new_run and new_run != fe.execution_id
    await _until(lambda: ran == [{"seed": 9}, {"seed": 9}], "replay re-executed")


@async_context
async def test_reexecute_single_step_from_recorded_input(tmp_path):
    ran: list[dict] = []

    @graph_workflow_functions.register("v2_reexec")
    def _fn_impl(event_name, data, ctx):
        ran.append(dict(data))
        return {}

    flow = await _make_flow(tmp_path, "reexecflow",
        [_fn("a", "v2_reexec")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = GraphWorkflowManager()
    fe = await fm.inject(flow.id, "go", {"k": 5})
    await _until(lambda: not fm.live_run_ids(), "first run finalized")

    new_run = await fm.reexecute(flow.id, fe.execution_id, 1)
    assert new_run and new_run != fe.execution_id
    await _until(lambda: ran == [{"k": 5}, {"k": 5}], "step re-executed with same input")


# ── retention ─────────────────────────────────────────────────────────────────


@async_context
async def test_retention_prunes_oldest_runs(tmp_path):
    @graph_workflow_functions.register("v2_retained")
    def _fn_impl(event_name, data, ctx):
        return {}

    flow = await _make_flow(tmp_path, "retained",
        [_fn("a", "v2_retained")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")],
        config={"retention_runs": 2})
    fm = GraphWorkflowManager()
    run_ids = []
    for i in range(4):
        fe = await fm.inject(flow.id, "go", {"i": i})
        run_ids.append(fe.execution_id)
        await _until(lambda: not fm.live_run_ids(), f"run {i} finalized")

    # The prune runs inside the (ensure_future'd) finalize AFTER the run pops
    # from the live map — poll the row count until it lands.
    rows = await GraphWorkflowRun.get_all({"flow_id": flow.id})
    for _ in range(600):
        rows = await GraphWorkflowRun.get_all({"flow_id": flow.id})
        if len(rows) <= 2:
            break
        await asyncio.sleep(0.005)
    assert len(rows) <= 2, f"retention kept {len(rows)} rows"
    kept = {r.id for r in rows}
    for rid in run_ids[:2]:
        assert rid not in kept, "oldest runs must be pruned"
        assert not run_record_dir(rid).exists(), "pruned run record dir must be gone"
        assert not (tmp_path / "retained" / "runs" / f"{rid}.jsonl").exists()
    for rid in run_ids[2:]:
        assert rid in kept


# ── agent budget gate (no real spawn) ─────────────────────────────────────────


@async_context
async def test_agent_process_budget_trips_before_spawn(tmp_path):
    """max_processes budget refuses further spawns; no AgenticProcess created."""
    flow = await _make_flow(tmp_path, "agentcap",
        [{"id": "a", "node_type": "agent",
          "node_data": {"program_kind": "instruction", "program_ref": "hi",
                        "execution_mode": "parallel", "parallel_limit": 99}}],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")],
        config={"max_processes": 3})

    fm = GraphWorkflowManager()
    run = await fm._start_run((await fm.load_flow(flow.id)))
    run.processes = 3  # the flow's own budget, exhausted
    node = (await fm.load_flow(flow.id)).doc.node("a")
    rt = fm._node_rt(flow.id, "a")
    rt.active += 1
    run.active += 1
    from flow_sdk.graph_workflow_manager.envelope import RunEvent

    await fm._spawn_agent(run, node, RunEvent(
        event="go", flow_id=flow.id, execution_id=run.id), rt, seq=1)
    assert run.error and "max_processes" in run.error


# ── agent node → Agent entity reference (definition alignment) ────────────────


AGENT_MD = """---
name: summarizer
description: test agent definition
model: sonnet
---
You are the summarizer. Always answer in one line.
"""


@async_context
async def test_agent_node_resolves_agent_entity_definition(tmp_path):
    """An agent node referencing an Agent entity (node_data.typeid) resolves
    the md definition: system prompt leads the instruction, md model applies,
    node model_size overrides it."""
    from flow_sdk.builtin.agent import Agent

    md = tmp_path / "summarizer.md"
    md.write_text(AGENT_MD, encoding="utf-8")
    agent = Agent(name="summarizer", asset_ref=str(md))
    await agent.save()

    flow = await _make_flow(tmp_path, "agentref",
        [{"id": "a", "node_type": "agent",
          "node_data": {"typeid": f"agent-{agent.id}", "prompt": "Summarize the payload."}}],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = GraphWorkflowManager()
    loaded = await fm.load_flow(flow.id)
    node = loaded.doc.node("a")
    assert loaded.doc.validate_graph() == []

    agent_def = await fm._resolve_agent_def(node)
    assert agent_def["agent_id"] == agent.id
    assert agent_def["model"] == "sonnet"
    # md model applies; node model_size (when set) wins.
    assert fm._agent_model(agent_def, node.node_data) == "sonnet"
    assert fm._agent_model(agent_def, {**node.node_data, "model_size": "sm"}) == "haiku"

    run = await fm._start_run(loaded)
    from flow_sdk.graph_workflow_manager.envelope import RunEvent

    fe = RunEvent(event="go", data={"x": 1}, flow_id=flow.id, execution_id=run.id)
    instruction = fm._agent_instruction(run, node, fe, tmp_path / "exec", agent_def)
    # Definition's system prompt leads; the node prompt rides after as addendum.
    assert instruction.startswith("You are the summarizer.")
    assert "Summarize the payload." in instruction
    assert instruction.index("You are the summarizer.") < instruction.index("Summarize the payload.")
    run.finalized = True  # abandon the synthetic run without executing


@async_context
async def test_agent_node_dangling_reference_fails_loudly(tmp_path):
    flow = await _make_flow(tmp_path, "agentdangle",
        [{"id": "a", "node_type": "agent",
          "node_data": {"typeid": "agent-2c9f8e64-3b21-4b4e-9a10-5f37f3d1c111"}}],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = GraphWorkflowManager()
    loaded = await fm.load_flow(flow.id)
    with pytest.raises(RuntimeError, match="not found"):
        await fm._resolve_agent_def(loaded.doc.node("a"))


def test_agent_node_without_definition_fails_validation():
    doc = parse_graph_workflow_doc(_doc(
        [{"id": "a", "node_type": "agent", "node_data": {}}], []))
    problems = "\n".join(doc.validate_graph())
    assert "need an Agent reference" in problems
    # Any one of typeid / program_ref / prompt satisfies it.
    ok = parse_graph_workflow_doc(_doc(
        [{"id": "a", "node_type": "agent", "node_data": {"prompt": "hi"}}], []))
    assert ok.validate_graph() == []


# ── phase 2: unified-bus boundary emissions (docs/flow-events.md) ────────────


@async_context
async def test_run_boundaries_emit_flow_tags(tmp_path):
    """A run dual-publishes its boundaries onto the bus: started → output →
    done, with the flow entity as target and run-innermost scope."""
    from flow_sdk.tags import event_bus

    @graph_workflow_functions.register("v2_bus_probe")
    def _probe(event_name, data, ctx):
        return {"ok": 1}

    flow = await _make_flow(tmp_path, "busflow",
        [_fn("a", "v2_bus_probe")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    got: list = []
    # Filter to THIS flow: the bus is a process-wide singleton, so a run still
    # finalizing from an earlier test would otherwise land its `flow.done` in
    # `got` before this run's `flow.started` and fail the ordering assert.
    unsub = event_bus.on("graph_workflow.*", got.append, target=f"graph_workflow:{flow.id}")
    try:
        fm = GraphWorkflowManager()
        fe = await fm.inject(flow.id, "go", {"x": 1})
        await _until(lambda: not fm.live_run_ids(), "run finalized")
        await _until(lambda: any(e.tag == "graph_workflow.done" for e in got), "done emitted")
    finally:
        unsub()

    tags = [e.tag for e in got]
    assert tags[0] == "graph_workflow.started"
    assert "graph_workflow.output" in tags and tags[-1] == "graph_workflow.done"
    for e in got:
        assert e.target == f"graph_workflow:{flow.id}"
        assert e.ctx.scope == [f"graph_workflow_run:{fe.execution_id}",
                               f"graph_workflow:{flow.id}"]
        assert e.data["run_id"] == fe.execution_id
    out = next(e for e in got if e.tag == "graph_workflow.output")
    assert out.data["event"] == "done" and out.data["payload"] == {"ok": 1}
    done = next(e for e in got if e.tag == "graph_workflow.done")
    assert done.data["status"] == "complete" and done.data["executions"] == 1


@async_context
async def test_guided_step_emits_waiting_and_step_done(tmp_path):
    from flow_sdk.tags import event_bus

    flow = await _make_flow(tmp_path, "busguided",
        [{"id": "g", "node_type": "guided_step",
          "node_data": {"status_line": "do the thing",
                        "present": {"dock": {"home": True}},
                        "await": {"tag": "manual"}}}],
        [_edge("e1", EXTERNAL_SOURCE, "begin", "g")])
    got: list = []
    unsub = event_bus.on("graph_workflow.*", got.append)
    try:
        fm = GraphWorkflowManager()
        fe = await fm.inject(flow.id, "begin", target_node="g")
        await _until(lambda: any(e.tag == "graph_workflow.waiting" for e in got), "parked")
        waiting = next(e for e in got if e.tag == "graph_workflow.waiting")
        assert waiting.data["node_id"] == "g"
        assert waiting.data["status_line"] == "do the thing"

        # Frontend releases the park: inject the node's done.
        await fm.inject(flow.id, "done", execution_id=fe.execution_id, source_node="g")
        await _until(lambda: any(e.tag == "graph_workflow.step.done" for e in got), "released")
        step = next(e for e in got if e.tag == "graph_workflow.step.done")
        assert step.data["node_id"] == "g" and step.data["event"] == "done"
        await _until(lambda: not fm.live_run_ids(), "run finalized")
    finally:
        unsub()


@async_context
async def test_tripped_run_emits_flow_failed(tmp_path):
    from flow_sdk.tags import event_bus

    @graph_workflow_functions.register("v2_bus_cycle")
    def _cyc(event_name, data, ctx):
        return {}

    flow = await _make_flow(tmp_path, "busfail",
        [_fn("a", "v2_bus_cycle")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a"), _edge("e2", "a", "done", "a")],
        config={"max_hops": 3})
    got: list = []
    unsub = event_bus.on("graph_workflow.failed", got.append)
    try:
        fm = GraphWorkflowManager()
        await fm.inject(flow.id, "go")
        await _until(lambda: not fm.live_run_ids(), "run finalized")
        await _until(lambda: bool(got), "failed emitted")
    finally:
        unsub()
    assert got[0].data["status"] == "tripped"
    assert "exceeds max" in (got[0].data["error"] or "")


@async_context
async def test_entry_reserve_survives_concurrent_finalize_sweep(tmp_path):
    """Regression (found live, phase-4 drill): a run must not sink between
    _start_run and its entry event landing — a concurrent drain's
    _maybe_finalize_all() used to sweep the 0/0 run before routing."""
    ran: list[str] = []

    @graph_workflow_functions.register("v2_reserve_probe")
    def _probe(event_name, data, ctx):
        ran.append(event_name)
        return {}

    flow = await _make_flow(tmp_path, "reserveflow",
        [{"id": "t1", "node_type": "trigger",
          "node_data": {"typeid": "trigger-2c9f8e64-3b21-4b4e-9a10-5f37f3d1c999"}},
         _fn("a", "v2_reserve_probe")],
        [_edge("e1", "t1", "fired", "a")])
    fm = GraphWorkflowManager()

    # Simulate the interleave at its WORST point: the sweep runs during
    # _start_run's own awaits (row save/attach/broadcast) — the run is already
    # registered but its entry event hasn't routed. Born-reserved pending=1
    # must hold it alive.
    orig_broadcast = fm._broadcast_run_event

    async def sweeping_broadcast(run, kind, payload):
        if kind == "run_start":
            fm._maybe_finalize_all()      # the concurrent drain's sweep
            await asyncio.sleep(0)        # let any wrongly-scheduled finalize land
        await orig_broadcast(run, kind, payload)

    fm._broadcast_run_event = sweeping_broadcast
    run_ids = await fm.on_trigger_fired("2c9f8e64-3b21-4b4e-9a10-5f37f3d1c999")
    assert run_ids, "run should start"
    await _until(lambda: ran == ["fired"], "entry event delivered despite sweep")
    await _until(lambda: not fm.live_run_ids(), "run finalized after routing")
    entries = read_run_journal(tmp_path / "reserveflow", run_ids[0])
    kinds = [e["kind"] for e in entries]
    # Ordering restored: the run must END after its entry event, never before.
    assert kinds.index("run_end") > kinds.index("event")


# ── phase 5: graph-level bus subscriptions ────────────────────────────────────


@async_context
async def test_flow_subscription_starts_run_with_mapped_entry(tmp_path):
    from flow_sdk.tags import emit_tag, target_of

    seen: list[dict] = []

    @graph_workflow_functions.register("v2_sub_probe")
    def _probe(event_name, data, ctx):
        seen.append({"event": event_name, "data": data})
        return {}

    flow = await _make_flow(tmp_path, "subflow", [_fn("a", "v2_sub_probe")], [])
    import json as _json
    doc = _json.loads((tmp_path / "subflow" / "graph.json").read_text())
    doc["subscriptions"] = [{"id": "s1", "pattern": "drill.sub.*",
                             "target": "usage_report:*", "node": "a"}]
    (tmp_path / "subflow" / "graph.json").write_text(_json.dumps(doc))

    fm = GraphWorkflowManager()
    assert (await fm.load_flow(flow.id)) is not None  # load arms
    emit_tag("drill.sub.ping", target_of("usage_report", "r-9"), {"k": 7})
    emit_tag("drill.sub.ping", target_of("task", "t-1"))  # target-filtered out
    await _until(lambda: len(seen) == 1, "subscription entry delivered")
    assert seen[0]["event"] == "drill.sub.ping"  # default entry name = tag
    assert seen[0]["data"] == {"tag": "drill.sub.ping",
                               "target": "usage_report:r-9", "data": {"k": 7}}
    await _until(lambda: not fm.live_run_ids(), "run finalized")


@async_context
async def test_flow_subscription_dedups_envelope_ids(tmp_path):
    from flow_sdk.tags import FlowEvent, event_bus

    seen: list[str] = []

    @graph_workflow_functions.register("v2_sub_dedup")
    def _probe(event_name, data, ctx):
        seen.append(event_name)
        return {}

    flow = await _make_flow(tmp_path, "dedupflow", [_fn("a", "v2_sub_dedup")], [])
    import json as _json
    doc = _json.loads((tmp_path / "dedupflow" / "graph.json").read_text())
    doc["subscriptions"] = [{"pattern": "dedup.*", "node": "a"}]
    (tmp_path / "dedupflow" / "graph.json").write_text(_json.dumps(doc))
    fm = GraphWorkflowManager()
    await fm.load_flow(flow.id)

    env = FlowEvent(tag="dedup.hit", target="x:1", ctx={"origin": "local_server"})
    event_bus.deliver(env)
    event_bus.deliver(env)  # at-least-once redelivery of the SAME envelope
    await _until(lambda: len(seen) >= 1, "first delivery")
    await asyncio.sleep(0.05)
    assert seen == ["dedup.hit"]  # exactly one run entry


@async_context
async def test_flow_subscription_self_loop_brake_allows_chaining(tmp_path):
    """Flow A's boundary events must never re-enter A; flow B chains off A."""
    entered: list[str] = []

    @graph_workflow_functions.register("v2_chain_a")
    def _a(event_name, data, ctx):
        return {"from_a": True}

    @graph_workflow_functions.register("v2_chain_b")
    def _b(event_name, data, ctx):
        entered.append(event_name)
        return {}

    import json as _json
    flow_a = await _make_flow(tmp_path, "chain-a", [_fn("n", "v2_chain_a")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "n")])
    doc_a = _json.loads((tmp_path / "chain-a" / "graph.json").read_text())
    # A subscribes to its OWN flow.done — the self-brake must refuse it.
    doc_a["subscriptions"] = [{"pattern": "graph_workflow.done",
                               "target": f"graph_workflow:{flow_a.id}", "node": "n"}]
    (tmp_path / "chain-a" / "graph.json").write_text(_json.dumps(doc_a))

    flow_b = await _make_flow(tmp_path, "chain-b", [_fn("m", "v2_chain_b")], [])
    doc_b = _json.loads((tmp_path / "chain-b" / "graph.json").read_text())
    doc_b["subscriptions"] = [{"pattern": "graph_workflow.done",
                               "target": f"graph_workflow:{flow_a.id}", "node": "m"}]
    (tmp_path / "chain-b" / "graph.json").write_text(_json.dumps(doc_b))

    fm = GraphWorkflowManager()
    await fm.load_flow(flow_a.id)
    await fm.load_flow(flow_b.id)
    await fm.inject(flow_a.id, "go")
    # B enters exactly once (from A's flow.done); A never re-enters itself.
    await _until(lambda: entered == ["graph_workflow.done"], "B chained off A")
    await asyncio.sleep(0.1)
    assert entered == ["graph_workflow.done"]
    await _until(lambda: not fm.live_run_ids(), "all runs finalized")


def test_graph_workflow_doc_subscription_validation():
    import json as _json
    parsed = parse_graph_workflow_doc(_json.dumps({
        "version": 1, "nodes": [{"id": "a", "node_type": "function",
                                 "node_data": {"function": "x"}}],
        "edges": [],
        "subscriptions": [{"pattern": "*"},
                          {"pattern": "ok.*", "node": "ghost"}],
    }))
    problems = "\n".join(parsed.validate_graph())
    assert "EVERY event" in problems
    assert "unknown node ghost" in problems


@async_context
async def test_flow_subscription_ping_pong_capped(tmp_path):
    """Two flows mutually subscribed (fresh envelopes per hop defeat dedup and
    the self-brake) — the per-flow entry cap bounds the loop, never silent."""
    import json as _json

    a_entries: list[int] = []

    @graph_workflow_functions.register("v2_pp_a")
    def _a(event_name, data, ctx):
        a_entries.append(1)
        return {}

    @graph_workflow_functions.register("v2_pp_b")
    def _b(event_name, data, ctx):
        return {}

    flow_a = await _make_flow(tmp_path, "pp-a", [_fn("n", "v2_pp_a")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "n")],
        config={"max_entries_per_minute": 3})
    flow_b = await _make_flow(tmp_path, "pp-b", [_fn("m", "v2_pp_b")], [],
        config={"max_entries_per_minute": 3})
    for name, fid, other, node in (("pp-a", flow_a.id, flow_b.id, "n"),
                                   ("pp-b", flow_b.id, flow_a.id, "m")):
        doc = _json.loads((tmp_path / name / "graph.json").read_text())
        doc["subscriptions"] = [{"pattern": "graph_workflow.done",
                                 "target": f"graph_workflow:{other}", "node": node}]
        (tmp_path / name / "graph.json").write_text(_json.dumps(doc))

    fm = GraphWorkflowManager()
    await fm.load_flow(flow_a.id)
    await fm.load_flow(flow_b.id)
    await fm.inject(flow_a.id, "go")
    await asyncio.sleep(0.5)  # let the ping-pong run into the cap
    # A entered once externally + at most cap(3) subscription entries.
    assert len(a_entries) <= 4
    await _until(lambda: not fm.live_run_ids(), "loop drained after cap")


@async_context
async def test_flow_subscription_fanout_enters_every_subscribed_flow(tmp_path):
    """One envelope fanning out to TWO subscribed flows must enter BOTH —
    dedup is per (flow, envelope), never global (regression: a global id set
    let the first flow consume the envelope for everyone)."""
    import json as _json
    from flow_sdk.tags import emit_tag

    entered: list[str] = []

    @graph_workflow_functions.register("v2_fan_x")
    def _x(event_name, data, ctx):
        entered.append("x")
        return {}

    @graph_workflow_functions.register("v2_fan_y")
    def _y(event_name, data, ctx):
        entered.append("y")
        return {}

    fm = GraphWorkflowManager()
    for name, fn_name, node in (("fan-x", "v2_fan_x", "nx"), ("fan-y", "v2_fan_y", "ny")):
        flow = await _make_flow(tmp_path, name, [_fn(node, fn_name)], [])
        doc = _json.loads((tmp_path / name / "graph.json").read_text())
        doc["subscriptions"] = [{"pattern": "fan.*", "node": node}]
        (tmp_path / name / "graph.json").write_text(_json.dumps(doc))
        await fm.load_flow(flow.id)

    emit_tag("fan.out", "x:1")  # ONE envelope, two subscribers
    await _until(lambda: sorted(entered) == ["x", "y"], "both flows entered")
    await _until(lambda: not fm.live_run_ids(), "runs finalized")


@async_context
async def test_entry_envelope_id_and_actor_preserved(tmp_path):
    """Phase 7: a run entered from a bus envelope preserves its id + actor —
    into the journal event row AND the example provenance."""
    import json as _json
    from flow_sdk.tags import FlowEvent, event_bus

    @graph_workflow_functions.register("v2_prov")
    def _p(event_name, data, ctx):
        return {}

    flow = await _make_flow(tmp_path, "provflow", [_fn("a", "v2_prov")], [])
    doc = _json.loads((tmp_path / "provflow" / "graph.json").read_text())
    doc["subscriptions"] = [{"pattern": "prov.*", "node": "a"}]
    (tmp_path / "provflow" / "graph.json").write_text(_json.dumps(doc))
    fm = GraphWorkflowManager()
    await fm.load_flow(flow.id)

    env = FlowEvent(tag="prov.go", target="x:1",
                    ctx={"origin": "local_server", "actor": "user:u-42"})
    event_bus.deliver(env)
    await _until(lambda: fm.live_run_ids() or None, "run started")
    await _until(lambda: not fm.live_run_ids(), "run finalized")

    run_id = (await GraphWorkflowRun.get_all({"flow_id": flow.id}))[0].id
    entries = read_run_journal(tmp_path / "provflow", run_id)
    entry_row = next(e for e in entries if e["kind"] == "event")
    assert entry_row["event_id"] == env.id      # preserved, never re-minted
    assert entry_row["actor"] == "user:u-42"

    exec_ex = _json.loads((run_record_dir(run_id) / "executions" / "1-a"
                           / "example.json").read_text())["metadata"]["source"]
    assert exec_ex["event_id"] == env.id
    assert exec_ex["actor"] == "user:u-42"
