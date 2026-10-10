"""``load_asset`` — what showing an asset does to make it ready: up → nothing; down → the node's run, at once.

The node, the check and the run are stubbed at their seams (``ProjectTree.load_one``, ``execute_setup``,
``start_setup``); what is under test is the ORDER and the one-node tree the run is handed. One test runs the
real walk over that tree to show a load is the ``on_load`` wizard and nothing else. No DB.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin import project_setup
from flow_sdk.core.setup import derive as setup_derive
from flow_sdk.core.setup import execute as setup_execute
from flow_sdk.core.setup import setup_tree
from flow_sdk.core.setup.load import _LoadTree, load_asset
from flow_sdk.core.setup.tree import SetupNode
from flow_sdk.core.setup.walk import _Walk
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.asset_setup_spec import SetupState, SetupTreeResult
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)

CHAIN = WizardSpec.model_validate({"name": "micro_app-a1", "steps": [{"id": "start", "kind": "compute", "ref": "serve"}]})
PROJECT = SimpleNamespace(id="p1", fs_storage_mount_path="/tmp/p1")
APP = SimpleNamespace(id="a1", typeid="micro_app-a1")


@pytest.fixture
def seams(monkeypatch):
    """Every seam a load crosses, recorded: whether it is up, what was checked, what was started with which tree."""
    state = SimpleNamespace(up=False, checked=[], started=[], node=None)
    state.node = SetupNode(id="micro_app-a1", label="site", on_load=CHAIN, inputs=(("webapp", "a1"),))

    class FakeTree:
        def __init__(self, _project, *, ai=True):
            pass

        async def load_one(self, _asset):
            return self

        async def resolve_node(self, node_id):
            return state.node if node_id == "micro_app-a1" else None

        async def resolve_op(self, _name):
            return None

    async def execute(root, *, resolve_node, check_only, **_kw):
        assert check_only
        state.checked.append(await resolve_node(root))
        return SetupTreeResult(state=SetupState.DONE if state.up else SetupState.PENDING, detail="" if state.up else "not up")

    async def start(project, *, root, tree=None, **_kw):
        state.started.append((root, tree))
        return f"setup-{root}"

    monkeypatch.setattr(setup_derive, "ProjectTree", FakeTree)
    monkeypatch.setattr(setup_execute, "execute_setup", execute)
    monkeypatch.setattr(project_setup, "start_setup", start)
    return state


@pytest.mark.asyncio
async def test_an_app_that_is_up_runs_nothing(seams):
    seams.up = True
    assert await load_asset(PROJECT, APP) is None
    assert seams.started == []
    [checked] = seams.checked
    assert (checked.prepare, checked.children, checked.run) == (None, (), CHAIN), "the check is the on_load wizard alone"


@pytest.mark.asyncio
async def test_an_app_that_is_down_has_its_load_started_with_the_tree_it_checked(seams):
    assert await load_asset(PROJECT, APP) == "setup-micro_app-a1"
    [(root, tree)] = seams.started
    assert root == "micro_app-a1" and isinstance(tree, _LoadTree)
    assert await tree.resolve_node("micro_app-a1") is seams.checked[0], "one tree, derived once"
    assert await tree.resolve_node("anything-else") is None


@pytest.mark.asyncio
async def test_an_asset_with_no_load_in_the_tree_is_left_alone(seams):
    seams.node = SetupNode(id="micro_app-a1", label="site")
    assert await load_asset(PROJECT, APP) is None
    assert seams.checked == [] and seams.started == []


@pytest.mark.asyncio
async def test_a_skipped_node_is_not_loaded(seams):
    seams.node = SetupNode(id="micro_app-a1", label="site", on_load=CHAIN, skipped="skipped on this machine")
    assert await load_asset(PROJECT, APP) is None
    assert seams.started == []


@pytest.mark.asyncio
async def test_a_load_that_cannot_be_judged_answers_none_and_never_raises(seams, monkeypatch):
    class Broken:
        def __init__(self, *_a, **_k):
            pass

        async def load_one(self, _asset):
            raise RuntimeError("the node will not derive")

    monkeypatch.setattr(setup_derive, "ProjectTree", Broken)
    assert await load_asset(PROJECT, APP) is None
    assert await load_asset(None, APP) is None


@pytest.mark.asyncio
async def test_the_walk_over_a_load_tree_runs_the_load_wizard_and_nothing_else(tmp_path):
    """The real walker, handed the one-node tree: not the node's prepare, not its children, not its run."""
    op = lambda name: ComputeOpSpec.model_validate({  # noqa: E731
        "name": name, "subkind": "cli", "exe_data": {"commands": {"linux": f"install {name}"}},
        "completion_check": {"commands": {"linux": f"have {name}"}},
    })
    ops = {"serve": op("serve"), "seed": op("seed"), "env": op("env")}
    wizard = lambda ref: WizardSpec.model_validate({"name": f"w-{ref}", "steps": [{"id": ref, "kind": "compute", "ref": ref}]})  # noqa: E731
    node = SetupNode(id="app", label="APP", prepare=wizard("env"), run=wizard("seed"), on_load=wizard("serve"), children=("dep",))
    installs: list[str] = []

    async def shell(command, **_kw):
        verb, _, name = command.partition(" ")
        if verb == "install":
            installs.append(name)
            return CliResult.of_process(command, 0)
        return CliResult.of_process(command, 0 if name in installs else 1)

    async def resolve_op(name):
        return Resolved(ops[name], True) if name in ops else None

    tree = _LoadTree(node, resolve_op)
    result = await setup_tree("app", resolve_node=tree.resolve_node, resolve_op=tree.resolve_op, workdir=tmp_path,
                              shell=shell, platform="linux", activity_path=f"setup-load-{tmp_path.name}")

    assert result.ok and installs == ["serve"], result.detail
    assert result.root.prepare is None and result.root.children == [] and result.root.run.ok
    assert isinstance(_Walk, type)  # the walker itself was not taught a load phase
