"""``load_asset`` — what showing an asset does to make it ready: warm → one probe; up → a stamp; down → a run.

The tree, the check and the run are stubbed at their seams (``ProjectTree``, ``execute_setup``,
``start_setup``, ``write_setup_load``); what is under test is the ORDER of the three answers and when the
stamp is written. No DB, no shell.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin import project_setup, webapp_setup
from flow_sdk.core.setup import derive as setup_derive
from flow_sdk.core.setup import execute as setup_execute
from flow_sdk.core.setup import skip_mark
from flow_sdk.core.setup.load import load_asset
from flow_sdk.core.setup.tree import SetupNode
from flow_sdk.schema.data_spec.asset_setup_spec import SetupLoadSpec, SetupState, SetupTreeResult
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(5)

CHAIN = WizardSpec.model_validate({"name": "micro_app-a1", "steps": [{"id": "start", "kind": "compute", "ref": "micro_app-a1:start"}]})
PROJECT = SimpleNamespace(id="p1", fs_storage_mount_path="/tmp/p1")


@pytest.fixture
def seams(monkeypatch):
    """Every seam a load crosses, recorded: what it probed, whether it built the tree, what it started, what it stamped."""
    state = SimpleNamespace(up=False, probes=0, built=0, started=[], stamps=[], on_done=None, node=None)
    state.node = SetupNode(id="micro_app-a1", label="site", on_load=CHAIN, inputs=(("webapp", "a1"),))

    async def step(_id, which, *, check):
        state.probes += 1
        return ReturnedValue(exit_code=ExitCode.OK if state.up else ExitCode.NOT_YET, ran=False)

    class FakeTree:
        def __init__(self, _project, *, ai=True):
            pass

        async def load(self):
            state.built += 1
            return self

        async def resolve_node(self, node_id):
            return state.node if node_id == "micro_app-a1" else None

        async def resolve_op(self, _name):
            return None

    async def execute(root, *, check_only, phase, **_kw):
        assert check_only and phase == "load"
        return SetupTreeResult(state=SetupState.DONE if state.up else SetupState.PENDING, detail="" if state.up else "not up")

    async def start(project, *, root, phase, on_done=None, **_kw):
        state.started.append((root, phase))
        state.on_done = on_done
        return f"setup-{root}"

    async def write(record, value):
        state.stamps.append(value)
        record.setup_loaded = value
        return record

    monkeypatch.setattr(webapp_setup, "step", step)
    monkeypatch.setattr(setup_derive, "ProjectTree", FakeTree)
    monkeypatch.setattr(setup_execute, "execute_setup", execute)
    monkeypatch.setattr(project_setup, "start_setup", start)
    monkeypatch.setattr(skip_mark, "write_setup_load", write)
    return state


def _app(stamped: bool = False):
    return SimpleNamespace(id="a1", typeid="micro_app-a1", setup_loaded=SetupLoadSpec(at=1.0) if stamped else None)


@pytest.mark.asyncio
async def test_a_stamped_app_that_answers_costs_one_probe_and_no_tree(seams):
    seams.up = True
    assert await load_asset(PROJECT, _app(stamped=True)) is None
    assert (seams.probes, seams.built, seams.started, seams.stamps) == (1, 0, [], [])


@pytest.mark.asyncio
async def test_a_first_load_that_finds_the_app_up_stamps_it_and_runs_nothing(seams):
    seams.up = True
    app = _app()
    assert await load_asset(PROJECT, app) is None
    assert seams.built == 1 and seams.started == []
    assert [s.run for s in seams.stamps] == [""] and app.setup_loaded is not None


@pytest.mark.asyncio
async def test_an_app_that_is_down_has_its_load_started_and_is_stamped_when_it_comes_up(seams):
    app = _app()
    assert await load_asset(PROJECT, app) == "setup-micro_app-a1"
    assert seams.started == [("micro_app-a1", "load")] and seams.stamps == [], "the stamp waits for the run"

    await seams.on_done(SetupTreeResult(state=SetupState.FAILED, detail="port never opened"))
    assert seams.stamps == [], "a load that did not reach its goal leaves no stamp"

    await seams.on_done(SetupTreeResult(state=SetupState.DONE))
    assert [(s.run, s.detail) for s in seams.stamps] == [("setup-micro_app-a1", "loaded")]


@pytest.mark.asyncio
async def test_a_stamped_app_that_died_with_the_machine_is_loaded_again(seams):
    """The stamp says it came up once, never that it is up now: the probe decides, every load."""
    app = _app(stamped=True)
    assert await load_asset(PROJECT, app) == "setup-micro_app-a1"
    assert seams.probes == 1 and seams.started == [("micro_app-a1", "load")]
    await seams.on_done(SetupTreeResult(state=SetupState.DONE))
    assert seams.stamps == [], "stamped already; nothing to add"


@pytest.mark.asyncio
async def test_an_asset_with_no_load_in_the_tree_is_left_alone(seams):
    seams.node = SetupNode(id="micro_app-a1", label="site")
    assert await load_asset(PROJECT, _app()) is None
    assert seams.started == [] and seams.stamps == []


@pytest.mark.asyncio
async def test_a_skipped_node_is_not_loaded(seams):
    seams.node = SetupNode(id="micro_app-a1", label="site", on_load=CHAIN, skipped="skipped on this machine")
    assert await load_asset(PROJECT, _app()) is None
    assert seams.started == []


@pytest.mark.asyncio
async def test_a_load_that_cannot_be_judged_answers_none_and_never_raises(seams, monkeypatch):
    class Broken:
        def __init__(self, *_a, **_k):
            pass

        async def load(self):
            raise RuntimeError("the tree will not build")

    monkeypatch.setattr(setup_derive, "ProjectTree", Broken)
    assert await load_asset(PROJECT, _app()) is None
    assert await load_asset(None, _app()) is None
    assert await load_asset(PROJECT, SimpleNamespace(id="x", typeid="skill-x")) is None, "only a loadable record"
