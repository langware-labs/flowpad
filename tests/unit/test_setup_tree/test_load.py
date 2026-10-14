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
    installed, ran, broken = set(), [], set()
    gate = asyncio.Event()
    gate.set()

    async def shell(command, **_kw):
        verb, name = command.split()
        if verb == "make":
            await gate.wait()
            ran.append(name)
            if name in broken:
                return CliResult.of_process(command, 1, stderr=f"{name} cannot start")
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
    return SimpleNamespace(project=project, tree=tree, installed=installed, ran=ran, gate=gate, nodes=nodes,
                           broken=broken)


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


async def finish(machine):
    """The run's end, whatever it was."""
    await project_setup._RUNS[(machine.project.id, "")]
    return load_state(machine.project.id)


@pytest.mark.asyncio
async def test_a_failed_load_names_the_step_that_failed_and_offers_setup_once(machine):
    machine.installed.update(("prepare", "install", "home", "app"))
    machine.broken.add("service")
    assert (await load_project(machine.project, tree=machine.tree)).state is LoadState.RUNNING
    failed = await finish(machine)
    assert failed.state is LoadState.FAILED and failed.setup_available
    assert "service" in failed.detail and "waiting on" not in failed.detail

    # The person says go. What setup made is gone too: setup runs, then the load.
    machine.installed.discard("install")
    machine.broken.clear()
    machine.ran.clear()
    assert (await load_project(machine.project, tree=machine.tree, approved=True)).state is LoadState.RUNNING
    assert (await finish(machine)).state is LoadState.READY
    assert machine.ran == ["install", "service"]


@pytest.mark.asyncio
async def test_a_load_that_still_fails_after_setup_stops_there(machine):
    machine.installed.update(("prepare", "install", "home", "app"))
    machine.broken.add("service")
    await load_project(machine.project, tree=machine.tree)
    assert (await finish(machine)).setup_available

    await load_project(machine.project, tree=machine.tree, approved=True)
    again = await finish(machine)
    assert again.state is LoadState.FAILED and not again.setup_available

    # Once it loads, the next failure is a new one and gets its own setup run.
    machine.broken.clear()
    await load_project(machine.project, tree=machine.tree)
    assert (await finish(machine)).state is LoadState.READY
    machine.installed.discard("service")
    machine.broken.add("service")
    await load_project(machine.project, tree=machine.tree)
    assert (await finish(machine)).setup_available


def apps(machine):
    """Two web apps beside each other; ``broken`` can never be installed."""
    root = machine.tree.root
    machine.nodes[root] = SetupNode(id=root, children=("good", "broken"))
    machine.nodes["good"] = SetupNode(id="good", label="Good", run=wizard("install"), independent=True)
    machine.nodes["broken"] = SetupNode(id="broken", label="Broken", run=wizard("prepare"), independent=True)
    machine.installed.add("install")
    return SimpleNamespace(typeid="good"), SimpleNamespace(typeid="broken")


@pytest.mark.asyncio
async def test_an_app_that_is_not_set_up_does_not_block_the_app_beside_it(machine):
    good, _broken = apps(machine)
    shown = await load_project(machine.project, tree=machine.tree, asset=good)
    assert shown.state is LoadState.READY and not machine.ran


@pytest.mark.asyncio
async def test_the_app_being_shown_still_has_to_be_set_up_itself(machine):
    _good, broken = apps(machine)
    result = await load_project(machine.project, tree=machine.tree, asset=broken)
    assert result.state is LoadState.SETUP_REQUIRED and "Broken" in result.detail
    assert not machine.ran


@pytest.mark.asyncio
async def test_a_run_for_one_app_is_judged_on_that_app_whoever_asks_how_it_went(machine):
    """The screen polls the load without naming the app. The app that was asked for could not start:
    that poll must not settle the run as ready just because the project stands without it."""
    root = machine.tree.root
    machine.nodes[root] = SetupNode(id=root, children=("good", "down"))
    machine.nodes["good"] = SetupNode(id="good", label="Good", on_load=wizard("home"), independent=True)
    machine.nodes["down"] = SetupNode(id="down", label="Down", on_load=wizard("service"), independent=True)
    machine.installed.add("home")
    machine.broken.add("service")

    started = await load_project(machine.project, tree=machine.tree, asset=SimpleNamespace(typeid="down"))
    assert started.state is LoadState.RUNNING
    await project_setup._RUNS[(machine.project.id, "down")]
    polled = load_state(machine.project.id)
    assert polled.state is LoadState.FAILED and "Down" in polled.detail
    assert load_state(machine.project.id, asset="down").state is LoadState.FAILED


@pytest.mark.asyncio
async def test_an_app_whose_folder_is_gone_is_not_ready(machine):
    gone = SimpleNamespace(typeid="gone", name="Site", asset_ref="/nowhere/site", on_disk=lambda: False)
    result = await load_project(machine.project, tree=machine.tree, asset=gone)
    assert result.state is LoadState.FAILED and "folder is gone: /nowhere/site" in result.detail
    assert not machine.ran


@pytest.mark.asyncio
async def test_setup_required_carries_the_checked_tree_so_the_question_shows_what_setup_means(machine):
    result = await load_project(machine.project, tree=machine.tree)
    assert result.state is LoadState.SETUP_REQUIRED and result.tree is not None
    assert [child.id for child in result.tree.root.children] == ["app", "asset_setup:service"]
    assert not machine.ran
    approved = await load_project(machine.project, tree=machine.tree, approved=True)
    assert approved.tree is None  # a running load is read from its run, not a snapshot


@pytest.mark.asyncio
async def test_a_forgotten_verdict_is_checked_again_and_a_running_one_is_kept(machine):
    """What a verdict was checked against changes (a setup run ended, a source turned active): kept, it
    goes on saying "requires setup" to every screen that only reads it."""
    from flow_sdk.core.setup.load import forget

    pid = machine.project.id
    assert (await load_project(machine.project, tree=machine.tree)).state is LoadState.SETUP_REQUIRED
    forget(pid)
    assert load_state(pid) is None, "no verdict: the next Load checks again"

    machine.gate.clear()  # the approved run is held mid-way
    assert (await load_project(machine.project, tree=machine.tree, approved=True)).state is LoadState.RUNNING
    forget(pid)
    assert load_state(pid).state is LoadState.RUNNING, "a run in flight is settled from its run, not dropped"
    machine.gate.set()
    assert (await settle(machine)).state is LoadState.READY


@pytest.mark.asyncio
async def test_a_setup_run_started_outside_a_load_drops_the_verdict_it_outdates(machine):
    """Project Setup (or one source's own Set up) fixes what the load found missing; the load's
    "requires setup" must not outlive it."""
    pid = machine.project.id
    assert (await load_project(machine.project, tree=machine.tree)).state is LoadState.SETUP_REQUIRED

    await project_setup.start_setup(machine.project, tree=machine.tree, root="asset_setup:service", load_after=False)
    await project_setup._RUNS[(pid, "asset_setup:service")]
    await asyncio.sleep(0)  # the run's done-callbacks

    assert load_state(pid) is None


def app_beside_a_credential(machine):
    """An app and a credential the person has not given, under one project — the fresh Acme clone."""
    root = machine.tree.root
    machine.nodes[root] = SetupNode(id=root, children=("cred", "web"))
    machine.nodes["cred"] = SetupNode(id="cred", label="Google Cloud", run=wizard("prepare"))
    machine.nodes["web"] = SetupNode(id="web", label="Admin", run=wizard("install"), on_load=wizard("service"),
                                     independent=True)
    machine.broken.add("prepare")
    return SimpleNamespace(typeid="web")


@pytest.mark.asyncio
async def test_a_credential_nobody_gave_never_keeps_the_app_beside_it_from_opening(machine):
    """Nothing blocks: setting the project up installs and starts the app even though the credential
    beside it fails, and the app's own load is READY. The run itself still says what is not set up."""
    web = app_beside_a_credential(machine)
    assert (await load_project(machine.project, tree=machine.tree, asset=web)).state is LoadState.SETUP_REQUIRED
    assert (await load_project(machine.project, tree=machine.tree, asset=web, approved=True)).state is LoadState.RUNNING
    run = await project_setup._RUNS[(machine.project.id, "web")]
    assert run.ok, run.detail
    assert machine.ran == ["install", "service"], "the app alone was installed and started; nobody was asked"
    shown = await load_project(machine.project, tree=machine.tree, asset=web)
    assert shown.state is LoadState.READY, shown.detail
