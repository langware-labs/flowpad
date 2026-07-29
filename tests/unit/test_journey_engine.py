"""Journey engine — guided_step park/resume lifecycle on the GraphWorkflowManager.

A guided_step parks the run (keeps it alive via `suspended`) instead of spawning
a worker; the frontend injects the node's `done` to release + route it onward.
No LLM, no frontend — just the engine contract the User Journey feature rides on.
"""
import asyncio
import json

from flow_sdk.builtin.graph_workflow_run import GraphWorkflowRun, RunStatus
from flow_sdk.builtin.journey import Journey
from flow_sdk.graph_workflow_manager import GraphWorkflowManager, parse_graph_workflow_doc
from flow_sdk.graph_workflow_manager.graph_workflow_doc import GUIDED_PRESENT_KINDS
from tests.conftest import async_context


async def _until(cond, what="condition"):
    for _ in range(600):
        if cond():
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"never reached: {what}")


def _step(node_id, name=""):
    return {
        "id": node_id, "node_type": "guided_step", "name": name or node_id,
        "node_data": {
            "status_line": f"Waiting at {node_id}",
            "present": {"dock": {"kind": "asset_editor", "vfs": f"{node_id}.html"}},
            "await": {"tag": "app.route.loaded", "vfs": "next.html"},
        },
    }


def _edge(eid, src, event, dst):
    return {"id": eid, "from": {"node": src, "event": event}, "to": {"node": dst}}


async def _make_journey(tmp_path, nodes, edges):
    journey = Journey(name="test-journey", asset_ref=str(tmp_path / "test-journey"))
    await journey.save()
    doc = {"version": 1, "id": journey.id, "name": "t", "enabled": True,
           "nodes": nodes, "edges": edges}
    (tmp_path / "test-journey" / "graph.json").write_text(json.dumps(doc), encoding="utf-8")
    return journey


def test_guided_step_validates():
    assert "asset_editor" in GUIDED_PRESENT_KINDS
    doc = parse_graph_workflow_doc(json.dumps({
        "version": 1, "nodes": [_step("s1"),
                                {"id": "bad", "node_type": "guided_step",
                                 "node_data": {"present": {"dock": {"kind": "nope"}},
                                               "await": {"kind": "legacy-no-tag"}}}],
        "edges": [],
    }))
    problems = "\n".join(doc.validate_graph())
    assert "present.dock.kind" in problems
    assert "await.tag" in problems


@async_context
async def test_guided_step_parks_and_advances(tmp_path):
    journey = await _make_journey(
        tmp_path,
        [_step("s1"), _step("s2")],
        [_edge("e1", "s1", "done", "s2")],
    )
    fm = GraphWorkflowManager()

    # Arm: deliver directly to s1 → the run PARKS (alive, suspended, not sunk).
    fe = await fm.inject(journey.id, "start", target_node="s1")
    assert fe is not None
    run_id = fe.execution_id
    await _until(lambda: run_id in fm._runs and fm._runs[run_id].suspended == 1, "parked at s1")
    assert fm._runs[run_id].suspended_nodes == {"s1"}
    assert run_id in fm.live_run_ids()  # a parked run stays alive

    # Advance s1: inject its `done` → releases s1, routes to s2 → parks at s2.
    await fm.inject(journey.id, "done", execution_id=run_id, source_node="s1")
    await _until(lambda: fm._runs.get(run_id) and fm._runs[run_id].suspended_nodes == {"s2"},
                 "parked at s2")
    assert run_id in fm.live_run_ids()

    # Advance s2 (terminal): no onward edge → run finalizes cleanly.
    await fm.inject(journey.id, "done", execution_id=run_id, source_node="s2")
    await _until(lambda: not fm.live_run_ids(), "run finalized")
    row = await GraphWorkflowRun.get_by_id(run_id)
    assert row is not None and row.status == RunStatus.COMPLETE.value


def test_shipped_journeys_are_valid():
    """Every journey we ship must pass `validate_graph`.

    A journey whose steps fail validation still indexes and still auto-launches
    — it simply can never advance, because the frontend subscribes to the
    `await` the graph declares. That is a silent, total failure of the tour, so
    it has to be a red build instead. (The `await.topic` → `await.tag` rename
    left one journey behind exactly this way.)
    """
    import glob
    from pathlib import Path

    graphs = sorted(glob.glob("flow_sdk/system_projects/*/agentic-assets/journey/*/graph.json"))
    assert graphs, "no shipped journeys found — did the path change?"
    problems = {
        Path(g).parent.name: parse_graph_workflow_doc(Path(g).read_text(encoding="utf-8")).validate_graph()
        for g in graphs
    }
    assert not any(problems.values()), problems
