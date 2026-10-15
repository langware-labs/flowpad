"""Provider lifecycle over the real setup walker, with a deterministic machine shell."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import project_setup
from flow_sdk.core.setup import execute as setup_execute
from flow_sdk.core.setup.load import LoadTree, forget, load_project, load_state, validate
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
    """An app and a credential the person has not given, under one project — the fresh Spora clone."""
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


def test_one_apps_running_load_is_never_another_apps_answer():
    """Spora Admin's setup run (asking for Google Cloud) was answered for the Back Office beside it, so
    opening the Back Office showed Admin's question. Two apps of one project are two loads."""
    from flow_sdk.core.setup import load as load_module

    pid = "p-two-apps"
    load_module._keep(pid, "micro_app-admin", load_module.LoadResult(
        state=LoadState.RUNNING, project_id=pid, run="setup-micro_app-admin"))
    try:
        assert load_module.load_state(pid, asset="micro_app-backoffice") is None
        assert load_module.load_state(pid, asset="micro_app-admin").run == "setup-micro_app-admin"
        # A poll that names no app is about the one last loaded.
        assert load_module.load_state(pid).run == "setup-micro_app-admin"
    finally:
        load_module._RESULTS.pop((pid, "micro_app-admin"), None)
        load_module._LATEST.pop(pid, None)


def one_app(machine, app_id="micro_app-up"):
    root = machine.tree.root
    machine.nodes[root] = SetupNode(id=root, children=(app_id,))
    machine.nodes[app_id] = SetupNode(id=app_id, label="Up", run=wizard("install"), on_load=wizard("app"))
    return SimpleNamespace(typeid=app_id)


@pytest.fixture
def answering(monkeypatch):
    """The app's health check, as a switch: ``answering["up"]`` is what every probe answers."""
    from flow_sdk.builtin import webapp_setup

    state = {"up": True}

    async def answers_now(_webapp_id):
        return state["up"]

    monkeypatch.setattr(webapp_setup, "answers_now", answers_now)
    return state


@pytest.mark.asyncio
async def test_an_app_loaded_ready_that_still_answers_opens_without_walking_anything(machine, answering, monkeypatch):
    app = one_app(machine)
    machine.installed.update(("install", "app"))
    assert (await load_project(machine.project, tree=machine.tree, asset=app)).state is LoadState.READY

    def no_tree(*_a, **_kw):
        raise AssertionError("a validated open walks nothing")

    import flow_sdk.core.setup as setup_package
    monkeypatch.setattr(setup_execute, "execute_setup", no_tree)
    monkeypatch.setattr(setup_package, "execute_setup", no_tree)
    assert (await validate(machine.project.id, app.typeid)).state is LoadState.READY
    assert (await load_project(machine.project, tree=machine.tree, asset=app)).state is LoadState.READY
    # Another session's display was never checked: its open is a load, not a validation.
    assert await validate(machine.project.id, app.typeid, "agentic_process-x") is None
    answering["up"] = False
    assert await validate(machine.project.id, app.typeid) is None


@pytest.mark.asyncio
async def test_a_running_app_validates_without_a_kept_verdict_but_a_display_needs_one(machine, answering):
    app = one_app(machine)
    # A running app opens as it is, never loaded or not; a display session's presentation is never assumed.
    assert (await validate(machine.project.id, app.typeid)).state is LoadState.READY
    assert await validate(machine.project.id, app.typeid, "agentic_process-x") is None


@pytest.mark.asyncio
async def test_a_run_rooted_at_one_app_leaves_its_siblings_verdicts(machine, answering):
    app = one_app(machine)
    machine.installed.update(("install", "app"))
    shown = await load_project(machine.project, tree=machine.tree, asset=app, display="agentic_process-x")
    assert shown.state is LoadState.READY
    forget(machine.project.id, "micro_app-sibling")  # a run of the app beside it ended
    assert (await validate(machine.project.id, app.typeid, "agentic_process-x")).state is LoadState.READY
    assert await validate(machine.project.id, app.typeid, "agentic_process-y") is None
    forget(machine.project.id, app.typeid)
    assert await validate(machine.project.id, app.typeid, "agentic_process-x") is None


@pytest.mark.asyncio
async def test_a_running_load_says_whether_it_starts_or_sets_up(machine):
    app = one_app(machine)
    machine.installed.add("install")
    started = await load_project(machine.project, tree=machine.tree, asset=app)
    assert started.state is LoadState.RUNNING and started.phase == "load"
    await project_setup._RUNS[(machine.project.id, app.typeid)]

    other = one_app(machine, "micro_app-new")
    machine.installed.clear()
    setting_up = await load_project(machine.project, tree=machine.tree, asset=other, approved=True)
    assert setting_up.state is LoadState.RUNNING and setting_up.phase == "setup"
    await project_setup._RUNS[(machine.project.id, other.typeid)]



# ── fix: the setup-fixer is a rung of the step, kept only by a setup run ─────────────────────────


def _ladder_tree():
    from flow_sdk.core.setup.derive import _op

    op = _op("app:start", "Start shop", "start", fixer="repair it")

    async def resolve_op(name):
        return Resolved(op, True) if name == op.name else None

    return SimpleNamespace(root="r", resolve_node=None, resolve_op=resolve_op), op


@pytest.mark.asyncio
async def test_a_plain_load_never_runs_the_fixer():
    tree, op = _ladder_tree()
    assert (await LoadTree(tree).resolve_op(op.name)).spec.attempts == []


@pytest.mark.asyncio
async def test_the_load_a_setup_run_ends_with_keeps_the_fixer():
    tree, op = _ladder_tree()
    assert (await LoadTree(tree, fix=True).resolve_op(op.name)).spec.attempts == op.attempts


@pytest.mark.asyncio
async def test_a_plain_load_keeps_a_ladder_with_no_agent_on_it():
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec

    op = ComputeOpSpec.model_validate({
        "name": "retry", "subkind": "cli", "exe_data": {"webapp_step": "start"},
        "completion_check": {"webapp_step": "start"},
        "attempts": [{"subkind": "cli", "exe_data": {"webapp_step": "start"}}],
    })

    async def resolve_op(_name):
        return Resolved(op, True)

    tree = SimpleNamespace(root="r", resolve_node=None, resolve_op=resolve_op)
    assert (await LoadTree(tree).resolve_op("retry")).spec.attempts == op.attempts
