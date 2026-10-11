"""Provider lifecycle over the real setup walker, with a deterministic machine shell."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import project_setup
from flow_sdk.core.setup import execute as setup_execute
from flow_sdk.core.setup.load import LoadTree, load_project, load_state
from flow_sdk.core.setup.tree import SetupNode
from flow_sdk.core.wizard import state as wizard_state
from flow_sdk.core.wizard.runner import Resolved
from flow_sdk.schema.data_spec.asset_setup_spec import LoadState
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)


def wizard(name):
    return WizardSpec.model_validate({"name": name, "steps": [{"id": name, "kind": "compute", "ref": name}]})


@pytest.fixture
def machine(tmp_path, monkeypatch):
    project = SimpleNamespace(id=tmp_path.name, name="Fixture", fs_storage_mount_path=str(tmp_path))
    root = f"project-{project.id}"
    nodes = {
        root: SetupNode(id=root, children=("app", "asset_setup:service")),
        "asset_setup:service": SetupNode(id="asset_setup:service", prepare=wizard("prepare"),
                                          run=wizard("install"), on_load=wizard("service")),
        "app": SetupNode(id="app", children=("asset_setup:home",), on_load=wizard("app")),
        "asset_setup:home": SetupNode(id="asset_setup:home", on_load=wizard("home")),
    }
    ops = {name: ComputeOpSpec.model_validate({"name": name, "subkind": "cli",
            "exe_data": {"commands": {p: f"make {name}" for p in ("linux", "darwin", "win32")}},
            "completion_check": {"commands": {p: f"have {name}" for p in ("linux", "darwin", "win32")}}})
           for name in ("prepare", "install", "service", "home", "app")}
    installed, ran = set(), []
    gate = asyncio.Event()
    gate.set()

    async def shell(command, **_kw):
        verb, name = command.split()
        if verb == "make":
            await gate.wait()
            ran.append(name)
            installed.add(name)
        return CliResult.of_process(command, 0 if name in installed else 1)

    async def resolve_node(name):
        return nodes.get(name)

    async def resolve_op(name):
        return Resolved(ops[name], True) if name in ops else None

    execute = setup_execute.execute_setup

    async def execute_with_shell(*a, **kw):
        kw["shell"] = shell
        return await execute(*a, **kw)

    monkeypatch.setattr(setup_execute, "execute_setup", execute_with_shell)
    # start_setup imports the package export; both paths run the real executor.
    import flow_sdk.core.setup as setup_package
    monkeypatch.setattr(setup_package, "execute_setup", execute_with_shell)
    monkeypatch.setattr(wizard_state, "run_dir", lambda key: tmp_path / "runs" / key)
    monkeypatch.setattr(setup_execute, "run_dir", lambda key: tmp_path / "runs" / key)
    tree = SimpleNamespace(root=root, gaps=[], resolve_node=resolve_node, resolve_op=resolve_op)
    return SimpleNamespace(project=project, tree=tree, installed=installed, ran=ran, gate=gate, nodes=nodes)


async def settle(machine):
    result = await project_setup._RUNS[(machine.project.id, "")]
    assert result.ok, result.detail
    return load_state(machine.project.id)


@pytest.mark.asyncio
async def test_decline_keeps_setup_required_and_approval_runs_setup_then_declared_loads(machine):
    first = await load_project(machine.project, tree=machine.tree)
    assert first.state is LoadState.SETUP_REQUIRED and not machine.ran
    # Not now makes no mutation; another Open asks exactly the same question.
    assert await load_project(machine.project, tree=machine.tree) == first
    approved = await load_project(machine.project, tree=machine.tree, approved=True)
    assert approved.state is LoadState.RUNNING and approved.run
    assert (await settle(machine)).state is LoadState.READY
    assert machine.ran == ["prepare", "install", "service", "home", "app"]


@pytest.mark.asyncio
async def test_stopped_service_reloads_without_repeating_setup(machine):
    machine.installed.update(("prepare", "install", "home", "app"))
    result = await load_project(machine.project, tree=machine.tree)
    assert result.state is LoadState.RUNNING
    await settle(machine)
    assert machine.ran == ["service"]
    assert (await load_project(machine.project, tree=machine.tree)).state is LoadState.READY
    assert machine.ran == ["service"]


@pytest.mark.asyncio
async def test_concurrent_consumers_join_one_provider_run(machine):
    machine.gate.clear()
    a, b = await asyncio.gather(*(load_project(machine.project, tree=machine.tree, approved=True) for _ in range(2)))
    assert a.state is b.state is LoadState.RUNNING and a.run == b.run
    machine.gate.set()
    await settle(machine)
    assert machine.ran.count("install") == 1 and machine.ran.count("service") == 1


@pytest.mark.asyncio
async def test_bad_declarations_are_reported_as_failure_not_ready(machine):
    async def broken(_node):
        raise ValueError("Malformed lifecycle")
    machine.tree.resolve_node = broken
    result = await load_project(machine.project, tree=machine.tree)
    assert result.state is LoadState.FAILED and "Malformed lifecycle" in result.detail


@pytest.mark.asyncio
async def test_operational_projection_keeps_children_and_omits_setup(machine):
    tree = LoadTree(machine.tree)
    node = await tree.resolve_node("asset_setup:service")
    assert node.prepare is None and node.run.name == "service"
    assert (await tree.resolve_node("app")).children == ("asset_setup:home",)
