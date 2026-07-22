"""FlowManager v2 unit tests — flow documents, local-event routing, runs,
scheduler, budgets, FlowFunction runtimes (inline + subprocess), standardized
I/O records, retention, and rerun. No LLM spawns (agent nodes are exercised
only up to the budget gate)."""
import asyncio
import json

import pytest

from flow_sdk.builtin.agentic_flow import AgenticFlow
from flow_sdk.builtin.agentic_flow_run import AgenticFlowRun, RunStatus
from flow_sdk.flow_manager import FlowManager, flow_functions, parse_flow_doc
from flow_sdk.flow_manager.envelope import EXTERNAL_SOURCE
from flow_sdk.flow_manager.journal import read_run_journal
from flow_sdk.flow_manager.manager import run_record_dir
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


async def _make_flow(tmp_path, name, nodes, edges, *, enabled=True, config=None) -> AgenticFlow:
    flow = AgenticFlow(name=name, asset_ref=str(tmp_path / name))
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


def test_flow_doc_parse_and_routing_lookups():
    doc = parse_flow_doc(_doc(
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


def test_flow_doc_config_defaults_and_overrides():
    doc = parse_flow_doc(_doc([], []))
    assert (doc.config.retention_runs, doc.config.max_hops,
            doc.config.max_processes, doc.config.deadline_s) == (5, 16, 10, 600)
    doc = parse_flow_doc(_doc([], [], config={"retention_runs": 2, "max_hops": 3}))
    assert doc.config.retention_runs == 2
    assert doc.config.max_hops == 3
    assert doc.config.deadline_s == 600  # untouched knobs keep defaults


def test_flow_doc_rejects_retired_spellings():
    with pytest.raises(ValueError, match='"pysdk" was retired'):
        parse_flow_doc(_doc([{"id": "p", "node_type": "pysdk", "node_data": {}}], []))
    with pytest.raises(ValueError, match='"process_runner" was renamed'):
        parse_flow_doc(_doc([{"id": "p", "node_type": "process_runner", "node_data": {}}], []))
    with pytest.raises(ValueError, match='"callback" was retired'):
        parse_flow_doc(_doc(
            [{"id": "p", "node_type": "agent",
              "node_data": {"program_kind": "callback", "program_ref": "x"}}], []))


def test_flow_doc_validation():
    doc = parse_flow_doc(_doc(
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


def test_flow_doc_function_runtime_defaults():
    doc = parse_flow_doc(_doc(
        [_fn("a", "flow_echo"), _fn("b", "scripts/x.py"),
         _fn("c", "flow_echo", runtime="subprocess")], []))
    assert doc.node("a").function_runtime() == "inline"
    assert doc.node("b").function_runtime() == "subprocess"
    assert doc.node("c").function_runtime() == "subprocess"


def test_flow_doc_rejects_bad_version():
    with pytest.raises(ValueError):
        parse_flow_doc('{"version": 99}')


# ── routing + run lifecycle (inline functions) ────────────────────────────────


@async_context
async def test_inject_routes_chain_and_run_completes(tmp_path):
    ran: list[str] = []

    @flow_functions.register("v2_first")
    def _first(event_name, data, ctx):
        ran.append(f"first:{event_name}")
        return {"x": 1}

    @flow_functions.register("v2_second")
    def _second(event_name, data, ctx):
        ran.append(f"second:{data.get('x')}")
        return {}

    flow = await _make_flow(tmp_path, "chain",
        [_fn("a", "v2_first"), _fn("b", "v2_second")],
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
    # Every execution row carries its seq pointer.
    seqs = [e["execution"]["seq"] for e in entries if e["kind"] == "node_done"]
    assert sorted(seqs) == [1, 2]


@async_context
async def test_run_and_execution_records_are_example_shaped(tmp_path):
    """The standardized I/O records: run input/output + inline execution dirs
    + born-compatible example.json stamps."""

    @flow_functions.register("v2_records")
    def _rec(event_name, data, ctx):
        ctx.log("hello record")
        return {"answer": data.get("q", 0) * 2}

    flow = await _make_flow(tmp_path, "records",
        [_fn("a", "v2_records")],
        [_edge("e1", EXTERNAL_SOURCE, "ask", "a")])
    fm = FlowManager()
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
    assert ex["source"] == {"flow_id": flow.id, "run_id": fe.execution_id, "node_id": "a",
                            "seq": 1, "event": "ask", "source_node": EXTERNAL_SOURCE, "hop": 0}
    run_ex = json.loads((run_dir / "execution" / "example.json").read_text())["metadata"]
    assert run_ex["source"]["node_id"] == "$run"


@async_context
async def test_catch_all_edge_routes_any_event(tmp_path):
    ran: list[str] = []

    @flow_functions.register("v2_catchall")
    def _fn_impl(event_name, data, ctx):
        ran.append(event_name)
        return {}

    flow = await _make_flow(tmp_path, "catchall",
        [_fn("a", "v2_catchall")],
        [_edge("e1", EXTERNAL_SOURCE, "*", "a")])

    fm = FlowManager()
    await fm.inject(flow.id, "anything.goes")
    await fm.inject(flow.id, "something.else")
    await _until(lambda: ran == ["anything.goes", "something.else"], "catch-all delivered")


@async_context
async def test_inactive_flow_refuses_injection(tmp_path):
    flow = await _make_flow(tmp_path, "inactive", [_fn("a", "flow_echo")],
                            [_edge("e1", EXTERNAL_SOURCE, "*", "a")], enabled=False)
    fm = FlowManager()
    with pytest.raises(ValueError, match="not active"):
        await fm.inject(flow.id, "go")


@async_context
async def test_target_node_delivers_directly(tmp_path):
    ran: list[str] = []

    @flow_functions.register("v2_direct")
    def _fn_impl(event_name, data, ctx):
        ran.append(event_name)
        return {}

    # no edges at all — only direct delivery reaches the node
    flow = await _make_flow(tmp_path, "direct", [_fn("a", "v2_direct")], [])
    fm = FlowManager()
    await fm.inject(flow.id, "poke", target_node="a")
    assert ran == ["poke"]


@async_context
async def test_hop_budget_trips_cycle_with_config_override(tmp_path):
    """a.done → a is an infinite loop; the flow's OWN max_hops trips the run."""
    count = {"n": 0}

    @flow_functions.register("v2_cycle")
    def _fn_impl(event_name, data, ctx):
        count["n"] += 1
        return {}

    flow = await _make_flow(tmp_path, "cycle",
        [_fn("a", "v2_cycle")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a"), _edge("e2", "a", "done", "a")],
        config={"max_hops": 4})
    fm = FlowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    row = await AgenticFlowRun.get_by_id(fe.execution_id)
    assert row is not None and row.status == RunStatus.TRIPPED.value
    assert count["n"] <= 5  # config max_hops(4) + the entry delivery


# ── scheduler (serial / merge) ────────────────────────────────────────────────


@async_context
async def test_serial_node_queues_second_delivery(tmp_path):
    order: list[str] = []
    gate: asyncio.Event = asyncio.Event()

    @flow_functions.register("v2_serial")
    async def _fn_impl(event_name, data, ctx):
        order.append(f"start:{data['n']}")
        if data["n"] == 1:
            await gate.wait()
        order.append(f"end:{data['n']}")
        return {}

    flow = await _make_flow(tmp_path, "serial",
        [_fn("a", "v2_serial", execution_mode="serial")],
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

    @flow_functions.register("v2_merge")
    async def _fn_impl(event_name, data, ctx):
        runs.append(data)
        await gate.wait()
        return {}

    flow = await _make_flow(tmp_path, "merge",
        [_fn("a", "v2_merge", execution_mode="serial", merge_identical=True)],
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


# ── subprocess functions (real subprocess + hidden process rows) ──────────────


PY_OK = """
def on_flow_event(event_name, data, flow_ctx):
    flow_ctx.log(f"got {event_name} n={data.get('n')}")
    (flow_ctx.output_folder / "artifact.txt").write_text("made this")
    return {"doubled": data.get("n", 0) * 2}
"""

PY_BOOM = """
import sys

def on_flow_event(event_name, data, flow_ctx):
    print("about to fail", file=sys.stderr)
    raise RuntimeError("boom from script")
"""


@async_context
async def test_subprocess_function_records_and_auto_done(tmp_path):
    """Script subprocess: hidden AgenticProcess row with its OWN standard
    folders, full stdio files, and the uniform dict-return auto-`done`."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    chained: list[dict] = []

    @flow_functions.register("v2_after_sub")
    def _after(event_name, data, ctx):
        chained.append(data)
        return {}

    flow = await _make_flow(tmp_path, "subok",
        [_fn("p", "scripts/ok.py", runtime="subprocess"), _fn("q", "v2_after_sub")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "p"), _edge("e2", "p", "done", "q")])
    (tmp_path / "subok" / "scripts" / "ok.py").write_text(PY_OK, encoding="utf-8")

    fm = FlowManager()
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

    fm = FlowManager()
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
    fm = FlowManager()
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
    fm = FlowManager()
    fe = await fm.inject(flow.id, "go")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    entries = read_run_journal(tmp_path / "submissing", fe.execution_id)
    errors = [e for e in entries if e["kind"] == "node_error"]
    assert errors and errors[0]["exit_code"] == 127


# ── rerun ─────────────────────────────────────────────────────────────────────


@async_context
async def test_replay_run_reinjects_recorded_entry(tmp_path):
    ran: list[dict] = []

    @flow_functions.register("v2_replayed")
    def _fn_impl(event_name, data, ctx):
        ran.append(dict(data))
        return {}

    flow = await _make_flow(tmp_path, "replayflow",
        [_fn("a", "v2_replayed")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = FlowManager()
    fe = await fm.inject(flow.id, "go", {"seed": 9})
    await _until(lambda: not fm.live_run_ids(), "first run finalized")

    new_run = await fm.replay_run(flow.id, fe.execution_id)
    assert new_run and new_run != fe.execution_id
    await _until(lambda: ran == [{"seed": 9}, {"seed": 9}], "replay re-executed")


@async_context
async def test_reexecute_single_step_from_recorded_input(tmp_path):
    ran: list[dict] = []

    @flow_functions.register("v2_reexec")
    def _fn_impl(event_name, data, ctx):
        ran.append(dict(data))
        return {}

    flow = await _make_flow(tmp_path, "reexecflow",
        [_fn("a", "v2_reexec")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")])
    fm = FlowManager()
    fe = await fm.inject(flow.id, "go", {"k": 5})
    await _until(lambda: not fm.live_run_ids(), "first run finalized")

    new_run = await fm.reexecute(flow.id, fe.execution_id, 1)
    assert new_run and new_run != fe.execution_id
    await _until(lambda: ran == [{"k": 5}, {"k": 5}], "step re-executed with same input")


# ── retention ─────────────────────────────────────────────────────────────────


@async_context
async def test_retention_prunes_oldest_runs(tmp_path):
    @flow_functions.register("v2_retained")
    def _fn_impl(event_name, data, ctx):
        return {}

    flow = await _make_flow(tmp_path, "retained",
        [_fn("a", "v2_retained")],
        [_edge("e1", EXTERNAL_SOURCE, "go", "a")],
        config={"retention_runs": 2})
    fm = FlowManager()
    run_ids = []
    for i in range(4):
        fe = await fm.inject(flow.id, "go", {"i": i})
        run_ids.append(fe.execution_id)
        await _until(lambda: not fm.live_run_ids(), f"run {i} finalized")

    # The prune runs inside the (ensure_future'd) finalize AFTER the run pops
    # from the live map — poll the row count until it lands.
    rows = await AgenticFlowRun.get_all({"flow_id": flow.id})
    for _ in range(600):
        rows = await AgenticFlowRun.get_all({"flow_id": flow.id})
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

    fm = FlowManager()
    run = await fm._start_run((await fm.load_flow(flow.id)))
    run.processes = 3  # the flow's own budget, exhausted
    node = (await fm.load_flow(flow.id)).doc.node("a")
    rt = fm._node_rt(flow.id, "a")
    rt.active += 1
    run.active += 1
    from flow_sdk.flow_manager.envelope import RunEvent

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
    fm = FlowManager()
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
    from flow_sdk.flow_manager.envelope import RunEvent

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
    fm = FlowManager()
    loaded = await fm.load_flow(flow.id)
    with pytest.raises(RuntimeError, match="not found"):
        await fm._resolve_agent_def(loaded.doc.node("a"))


def test_agent_node_without_definition_fails_validation():
    doc = parse_flow_doc(_doc(
        [{"id": "a", "node_type": "agent", "node_data": {}}], []))
    problems = "\n".join(doc.validate_graph())
    assert "need an Agent reference" in problems
    # Any one of typeid / program_ref / prompt satisfies it.
    ok = parse_flow_doc(_doc(
        [{"id": "a", "node_type": "agent", "node_data": {"prompt": "hi"}}], []))
    assert ok.validate_graph() == []
