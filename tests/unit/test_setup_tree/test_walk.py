"""``setup_tree`` — the walk: ``prepare`` on the way down, the children, ``run`` on the way up.

Every node's wizards are one-step wizards over convergent cli ops (``have X`` is the check, ``install X``
the call), so the order the walk takes is the order the ``install`` commands reach the shell. Real
runner, stub resolvers, stub shell; no DB.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.activity import Activity
from flow_sdk.core.compute.receipt import receipt_path
from flow_sdk.core.compute_op.runner import VALUE_KEY
from flow_sdk.core.setup import MAX_SETUP_DEPTH, SetupNode, setup_tree
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.asset_setup_spec import SetupState, SetupTreeResult
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, PromptResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)


def _op(name: str) -> ComputeOpSpec:
    return ComputeOpSpec.model_validate(
        {
            "name": name,
            "subkind": "cli",
            "exe_data": {"commands": {"linux": f"install {name}"}},
            "completion_check": {"commands": {"linux": f"have {name}"}},
        }
    )


def _wizard(op: str) -> WizardSpec:
    return WizardSpec.model_validate({"name": f"w-{op}", "steps": [{"id": op, "kind": "compute", "ref": op}]})


class Machine:
    """A shell where ``have X`` holds once ``install X`` ran, and ``install X`` fails for X in ``broken``."""

    def __init__(self, *, broken=(), installed=()):
        self.broken = set(broken)
        self.installed = set(installed)
        self.installs: list[str] = []
        self.envs: dict[str, dict] = {}

    async def __call__(self, command, **kw):
        verb, _, name = command.partition(" ")
        self.envs[command] = dict(kw.get("extra_env") or {})
        if verb == "install":
            self.installs.append(name)
            if name in self.broken:
                return CliResult.of_process(command, 1)
            self.installed.add(name)
            return CliResult.of_process(command, 0)
        return CliResult.of_process(command, 0 if name in self.installed else 1)


class Tree:
    """Nodes by id; each names the ops its ``prepare`` / ``run`` wizards call."""

    def __init__(self):
        self.nodes: dict[str, SetupNode] = {}
        self.ops: dict[str, ComputeOpSpec] = {}
        self.asked: list[str] = []

    def node(self, id, *, prepare=None, run=None, children=(), trusted=True, inputs=(), wizard=None):
        for op in (prepare, run):
            if op:
                self.ops[op] = _op(op)
        self.nodes[id] = SetupNode(
            id=id,
            label=id.upper(),
            prepare=_wizard(prepare) if prepare else None,
            run=wizard or (_wizard(run) if run else None),
            children=tuple(children),
            trusted=trusted,
            inputs=tuple(inputs),
        )
        return self

    async def resolve_node(self, id):
        self.asked.append(id)
        return self.nodes.get(id)

    async def resolve_op(self, name):
        spec = self.ops.get(name)
        return Resolved(spec, True) if spec is not None else None


async def _setup(tree: Tree, root: str, machine: Machine, tmp_path: Path, **over) -> SetupTreeResult:
    async def launch(**_kw):
        return PromptResult.satisfied("agent finished", executor="agentic_process-proc-1")

    return await setup_tree(
        root,
        resolve_node=tree.resolve_node,
        resolve_op=tree.resolve_op,
        activity_path=f"setup-test-{tmp_path.name}",
        workdir=tmp_path,
        shell=machine,
        launch=over.pop("launch", launch),
        platform="linux",
        **over,
    )


def _states(result: SetupTreeResult) -> dict[str, str]:
    out: dict[str, str] = {}

    def walk(node):
        out.setdefault(node.id, node.state.value)
        for child in node.children:
            walk(child)

    walk(result.root)
    return out


# ── order ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_prepare_runs_on_the_way_down_and_run_on_the_way_up(tmp_path):
    tree = (
        Tree()
        .node("p", prepare="p-pre", run="p-run", children=["a", "b"])
        .node("a", run="a-run")
        .node("b", prepare="b-pre", run="b-run", children=["c"])
        .node("c", run="c-run")
    )
    machine = Machine()

    result = await _setup(tree, "p", machine, tmp_path)

    assert result.ok and result.ran
    assert machine.installs == ["p-pre", "a-run", "b-pre", "c-run", "b-run", "p-run"]
    assert (result.total, result.done) == (4, 4)
    assert [c.level for c in result.root.children[1].children] == [2]


@pytest.mark.asyncio
async def test_a_node_with_no_wizards_is_just_its_children(tmp_path):
    tree = Tree().node("p", children=["a"]).node("a", run="a-run")
    result = await _setup(tree, "p", Machine(), tmp_path)
    assert result.ok and _states(result) == {"p": "done", "a": "done"}


# ── one visit per node ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_child_two_parents_share_is_set_up_once(tmp_path):
    tree = (
        Tree()
        .node("p", children=["a", "b"])
        .node("a", run="a-run", children=["cred"])
        .node("b", run="b-run", children=["cred"])
        .node("cred", run="cred-run")
    )
    machine = Machine()

    result = await _setup(tree, "p", machine, tmp_path)

    assert result.ok
    assert machine.installs.count("cred-run") == 1
    second = result.root.children[1].children[0]
    assert second.shared and second.state is SetupState.DONE and second.children == []
    assert result.total == 4, "a shared node counts once"


@pytest.mark.asyncio
async def test_a_cycle_is_refused_before_anything_runs(tmp_path):
    tree = Tree().node("a", run="a-run", children=["b"]).node("b", run="b-run", children=["a"])
    machine = Machine()

    result = await _setup(tree, "a", machine, tmp_path)

    assert result.state is SetupState.REFUSED
    assert "a -> b -> a" in result.detail
    assert machine.installs == []


@pytest.mark.asyncio
async def test_a_runaway_depth_is_refused_before_anything_runs(tmp_path):
    tree = Tree()
    for level in range(MAX_SETUP_DEPTH + 2):
        tree.node(f"n{level}", run=f"r{level}", children=[f"n{level + 1}"])
    machine = Machine()

    result = await _setup(tree, "n0", machine, tmp_path)

    assert result.state is SetupState.REFUSED and f"more than {MAX_SETUP_DEPTH} levels" in result.detail
    assert machine.installs == []


# ── failure ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_failed_child_blocks_its_ancestors_and_its_siblings_still_run(tmp_path):
    tree = (
        Tree()
        .node("p", run="p-run", children=["mid", "c"])
        .node("mid", run="mid-run", children=["a", "b"])
        .node("a", run="a-run")
        .node("b", run="b-run")
        .node("c", run="c-run")
    )
    machine = Machine(broken={"a-run"})

    result = await _setup(tree, "p", machine, tmp_path)

    assert result.state is SetupState.BLOCKED
    assert _states(result) == {"p": "blocked", "mid": "blocked", "a": "failed", "b": "done", "c": "done"}
    assert "mid-run" not in machine.installs and "p-run" not in machine.installs
    assert machine.installs == ["a-run", "b-run", "c-run"]
    assert "waiting on A" in result.root.children[0].detail
    assert "waiting on MID" in result.detail
    assert (result.total, result.done) == (5, 2)


@pytest.mark.asyncio
async def test_a_failed_prepare_skips_the_nodes_children(tmp_path):
    tree = Tree().node("p", prepare="p-pre", run="p-run", children=["a"]).node("a", run="a-run")
    machine = Machine(broken={"p-pre"})

    result = await _setup(tree, "p", machine, tmp_path)

    assert _states(result) == {"p": "failed", "a": "pending"}
    assert machine.installs == ["p-pre"]


@pytest.mark.asyncio
async def test_a_missing_child_fails_where_it_stands(tmp_path):
    tree = Tree().node("p", run="p-run", children=["gone", "a"]).node("a", run="a-run")

    result = await _setup(tree, "p", Machine(), tmp_path)

    assert _states(result) == {"p": "blocked", "gone": "failed", "a": "done"}
    assert "nothing named 'gone'" in result.root.children[0].detail


@pytest.mark.asyncio
async def test_a_refusal_stops_the_whole_walk(tmp_path):
    tree = (
        Tree()
        .node("p", run="p-run", children=["untrusted", "later"])
        .node("untrusted", run="u-run", trusted=False)
        .node("later", run="later-run")
    )
    machine = Machine()

    result = await _setup(tree, "p", machine, tmp_path)

    assert result.state is SetupState.REFUSED
    assert _states(result)["untrusted"] == "refused" and _states(result)["later"] == "pending"
    assert machine.installs == []


@pytest.mark.asyncio
async def test_an_approved_run_lets_an_untrusted_node_run(tmp_path):
    tree = Tree().node("p", run="p-run", trusted=False)
    result = await _setup(tree, "p", Machine(), tmp_path, approved=True)
    assert result.ok


# ── resume, check ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_second_run_finds_everything_in_place_and_runs_nothing(tmp_path):
    tree = Tree().node("p", prepare="p-pre", run="p-run", children=["a"]).node("a", run="a-run")
    machine = Machine()
    await _setup(tree, "p", machine, tmp_path)
    machine.installs.clear()

    again = await _setup(tree, "p", machine, tmp_path)

    assert again.ok and not again.ran and machine.installs == []
    assert again.root.detail == "already set up"


@pytest.mark.asyncio
async def test_a_resumed_run_continues_from_the_broken_leaf(tmp_path):
    tree = Tree().node("p", run="p-run", children=["a", "b"]).node("a", run="a-run").node("b", run="b-run")
    machine = Machine(broken={"b-run"})
    first = await _setup(tree, "p", machine, tmp_path)
    assert first.state is SetupState.BLOCKED
    machine.broken.clear()
    machine.installs.clear()

    second = await _setup(tree, "p", machine, tmp_path)

    assert second.ok and machine.installs == ["b-run", "p-run"]


@pytest.mark.asyncio
async def test_check_only_runs_nothing_and_says_what_is_not_set_up(tmp_path):
    tree = Tree().node("p", run="p-run", children=["a", "b"]).node("a", run="a-run").node("b", run="b-run")
    machine = Machine(installed={"a-run"})

    result = await _setup(tree, "p", machine, tmp_path, check_only=True)

    assert machine.installs == []
    assert _states(result) == {"p": "blocked", "a": "done", "b": "pending"}
    assert not result.ok


@pytest.mark.asyncio
async def test_check_only_on_a_set_up_tree_is_done(tmp_path):
    tree = Tree().node("p", run="p-run", children=["a"]).node("a", run="a-run")
    result = await _setup(tree, "p", Machine(installed={"a-run", "p-run"}), tmp_path, check_only=True)
    assert result.ok and not result.ran


# ── values flow down ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_nodes_inputs_reach_every_wizard_below_it(tmp_path):
    tree = (
        Tree()
        .node("p", children=["a"], inputs=[("project", "proj-1")])
        .node("a", run="a-run", inputs=[("source", "src-1")])
    )
    machine = Machine()

    await _setup(tree, "p", machine, tmp_path)

    env = machine.envs["install a-run"]
    assert env["FLOWPAD_WIZARD_INPUT_PROJECT"] == "proj-1" and env["FLOWPAD_WIZARD_INPUT_SOURCE"] == "src-1"


@pytest.mark.asyncio
async def test_what_prepare_returns_is_in_scope_for_the_children(tmp_path):
    """A ``prepare`` step's id names the value it passes down (the wizard's outputs are keyed by step)."""
    port = ComputeOpSpec.model_validate(
        {"name": "pick-port", "subkind": "agent", "output_spec_kind": "string",
         "exe_data": {"agent": "provisioner", "prompt": "pick a port"}}
    )
    tree = Tree().node("p", children=["a"]).node("a", run="a-run")
    tree.ops["pick-port"] = port
    tree.nodes["p"] = SetupNode(
        id="p", children=("a",),
        prepare=WizardSpec.model_validate({"name": "prep", "steps": [{"id": "port", "kind": "compute", "ref": "pick-port"}]}),
    )

    async def launch(*, workdir, **_kw):
        path = receipt_path(Path(workdir), "pick-port")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"status": "done", "summary": "5001", "data": {VALUE_KEY: "5001"}}))
        return PromptResult.satisfied("picked", executor="agentic_process-proc-1")

    machine = Machine()
    result = await _setup(tree, "p", machine, tmp_path, launch=launch)

    assert result.ok
    assert machine.envs["install a-run"]["FLOWPAD_WIZARD_INPUT_PORT"] == "5001"


# ── the report ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_one_activity_tree_reports_every_node_and_its_wizards(tmp_path):
    tree = Tree().node("p", run="p-run", children=["a", "b"]).node("a", run="a-run").node("b", run="b-run")
    machine = Machine(broken={"b-run"})

    path, seen = f"setup-test-{tmp_path.name}", []

    async def watch(_snapshot):
        # A finished root is evicted (the monitor holds LIVE work), so read the tree while it runs.
        seen.append(Activity.get(path, subject_entity="project-1").spec())

    await _setup(tree, "p", machine, tmp_path, subject_entity="project-1", on_change=watch)

    spec = seen[-1]
    assert spec.label == "P" and spec.total == 3 and (spec.done, spec.errors_count) == (1, 1)
    kids = {child.name: child for child in spec.children}
    assert set(kids) == {"p", "a", "b"}, "one flat row per node: the hierarchy rides the `level` counter"
    assert (kids["a"].counters["level"], kids["p"].counters["level"]) == (1, 0)
    assert kids["a"].state == "completed" and kids["b"].state == "failed" and kids["p"].state == "cancelled"
    assert kids["p"].message.startswith("Blocked — waiting on B")
    run = {child.name: child for child in kids["a"].children}["run"]
    assert [step.name for step in run.children] == ["a-run"]


@pytest.mark.asyncio
async def test_on_change_sees_the_tree_fill_in_and_ends_with_the_answer(tmp_path):
    tree = Tree().node("p", run="p-run", children=["a"]).node("a", run="a-run")
    seen: list[SetupTreeResult] = []

    async def on_change(snapshot):
        seen.append(snapshot)

    result = await _setup(tree, "p", Machine(), tmp_path, on_change=on_change)

    assert seen[0].root.state is SetupState.PENDING and seen[0].total == 2
    assert any(s.root.children[0].state is SetupState.DONE and s.root.state is SetupState.RUNNING for s in seen)
    assert result.ok


@pytest.mark.asyncio
async def test_a_second_setup_of_the_same_root_is_held(tmp_path):
    tree = Tree().node("p", run="p-run")
    path = f"setup-test-{tmp_path.name}"
    async with Activity.claim(path):
        result = await _setup(tree, "p", Machine(), tmp_path)
    assert result.state is SetupState.HELD


@pytest.mark.asyncio
async def test_a_node_records_what_its_run_answered_and_a_check_records_nothing(tmp_path):
    recorded = []

    async def record(result):
        recorded.append(result.ok)

    tree = Tree().node("p", run="p-run")
    tree.nodes["p"] = SetupNode(id="p", run=tree.nodes["p"].run, record=record)

    await _setup(tree, "p", Machine(), tmp_path, check_only=True)
    await _setup(tree, "p", Machine(), tmp_path)

    assert recorded == [True]


@pytest.mark.asyncio
async def test_a_node_with_a_problem_fails_with_it_and_blocks_its_parent(tmp_path):
    tree = Tree().node("p", run="p-run", children=["broken", "fine"]).node("fine", run="f-run")
    tree.nodes["broken"] = SetupNode(id="broken", label="Container", problem="names the wizard 'nope', which is not here")
    machine = Machine()

    result = await _setup(tree, "p", machine, tmp_path)

    assert _states(result) == {"p": "blocked", "broken": "failed", "fine": "done"}
    assert result.root.children[0].detail == "names the wizard 'nope', which is not here"
    assert machine.installs == ["f-run"]
