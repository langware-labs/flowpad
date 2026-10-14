"""``ProjectTree`` — a project's setup tree, derived from what it already knows about itself.

No DB: the project's requirements, sources, drivers, wizards, web apps and declared ``asset_setup``
rows are stubbed where the derivation reads them; ``compile_setup`` (pure) builds the credential and
connection wizards for real, and the walk runs them over a stub shell.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin import project_setup, readiness, webapp_setup
from flow_sdk.builtin.asset_setup import AssetSetup
from flow_sdk.builtin.wizard import Wizard
from flow_sdk.core.setup import derive, setup_tree
from flow_sdk.core.setup.derive import ProjectTree, _holder
from flow_sdk.schema.data_spec.asset_setup_spec import AssetSetupSpec, SetupState
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
from flow_sdk.schema.data_spec.project_setup_spec import SetupRequirementSpec, SetupVarSpec
from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode, ReturnedValue
from flow_sdk.schema.data_spec.setup_stage_spec import SetupStageSpec
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

pytestmark = pytest.mark.timeout(10)


@dataclass
class FakeSource:
    id: str
    name: str
    provider: str
    owner: str = ""
    asset_ref: str = ""
    setup_skipped: object = None

    @property
    def typeid(self) -> str:
        return f"data_source-{self.id}"


@dataclass
class FakeWizard:
    name: str
    steps: list = field(default_factory=list)
    id: str = "11111111-1111-4111-8111-111111111111"

    def spec(self):
        return WizardSpec.model_validate({"name": self.name, "steps": self.steps})

    def is_system(self):
        return True


def _stage_op(name):
    return ComputeOpSpec.model_validate({
        "name": name, "subkind": "cli", "exe_data": {"commands": {"linux": f"install {name}"}},
        "completion_check": {"commands": {"linux": f"have {name}"}},
    })


@pytest.fixture
def project(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    driver_folder = root / "agentic-assets" / "data_driver" / "waha"
    reqs = [
        SetupRequirementSpec(kind="pack", name="stripe", vars=[SetupVarSpec(env_var="STRIPE_KEY", present=True)],
                             used_by=["project"], satisfied=True),
        SetupRequirementSpec(kind="pack", credential_kind="oauth", name="google", provider="google", scopes=["drive"], used_by=["drive"]),
        SetupRequirementSpec(kind="gap", name="MYSTERY", used_by=["drive"], note="nobody declares it"),
    ]
    sources = [FakeSource("d1", "drive", "gdrive"), FakeSource("w1", "waha", "waha", owner="agent-a")]
    drivers = {
        "gdrive": SimpleNamespace(setup_wizards=[]),
        "waha": SimpleNamespace(folder=driver_folder, setup_wizards=[
            SetupStageSpec(stage="server", wizard="waha-server-stage"),
            SetupStageSpec(stage="pair", wizard="waha-pair-stage"),
        ]),
    }
    wizards = {
        "waha-server-stage": FakeWizard("waha-server-stage", [{"id": "s", "kind": "compute", "ref": "server-op"}]),
        "waha-pair-stage": FakeWizard("waha-pair-stage", [{"id": "p", "kind": "compute", "ref": "pair-op"}]),
        "waha-container": FakeWizard("waha-container", [{"id": "c", "kind": "compute", "ref": "container-op"}]),
    }
    declared = AssetSetup(name="waha-container", asset_ref=str(driver_folder / "agentic-assets" / "asset_setup" / "waha-container"))
    monkeypatch.setattr(AssetSetup, "spec", lambda self: AssetSetupSpec(name="waha-container", label="WAHA container", run="waha-container"))
    monkeypatch.setattr(AssetSetup, "is_system", lambda self: False)

    async def collect(_p, *_a):
        return reqs

    async def sources_of(_p):
        return sources

    async def driver_of(provider):
        return drivers.get(provider)

    async def by_name(name, near=""):
        return wizards.get(name)

    async def all_setups(_q):
        return [declared]

    async def webapps(_self):
        return [SimpleNamespace(id="a1", name="site", typeid="micro_app-a1", asset_ref=str(root / "site"), setup_skipped=None)]

    async def source_step(op, env, *, check, platform):
        """A fake source's own steps hold (its verify passes): the in-process step is the source's business."""
        return CliResult.of_process(f"source step {op.source_step}", 0)

    from flow_sdk.core.compute_op import runner as op_runner

    monkeypatch.setattr(op_runner, "_source_step", source_step)
    monkeypatch.setattr(project_setup, "collect_requirements", collect)
    monkeypatch.setattr(project_setup, "project_sources", sources_of)
    monkeypatch.setattr(readiness, "driver_of", driver_of)
    monkeypatch.setattr(Wizard, "by_name", by_name)
    monkeypatch.setattr(AssetSetup, "get_all", all_setups)
    monkeypatch.setattr(ProjectTree, "_webapps", webapps)
    return SimpleNamespace(id="p1", name="Shop", fs_storage_mount_path=str(root))


@pytest.mark.asyncio
async def test_the_tree_puts_each_need_under_the_asset_that_needs_it(project):
    tree = await ProjectTree(project).load()
    node = tree.nodes

    assert node["project-p1"].children == ("credential:stripe", "data_source-d1", "data_source-w1", "micro_app-a1")
    assert node["data_source-d1"].children == ("connection:google",), "a source's own needs sit under it"
    assert [s.ref for s in node["data_source-d1"].run.steps] == ["data_source-d1:verify"], (
        "a source with no stages still verifies — else the tree calls a source in setup done"
    )
    assert node["data_source-w1"].run is None, "a source with stages verifies in its last stage"
    assert node["data_source-w1"].children == ("stage:w1:waha-pair-stage",)
    assert node["stage:w1:waha-pair-stage"].children == ("stage:w1:waha-server-stage",), "a stage follows the one before"
    assert node["stage:w1:waha-server-stage"].children == ("asset_setup:waha-container",), (
        "what the source needs comes up before its FIRST stage, never beside it"
    )
    assert dict(node["stage:w1:waha-server-stage"].inputs) == {"source": "w1", "owner": "agent-a"}
    assert [g.name for g in tree.gaps] == ["MYSTERY"] and "gap:MYSTERY" not in node
    assert node["asset_setup:waha-container"].trusted is False, "a connector's own wizard is not ours"
    assert [s.ref for s in node["micro_app-a1"].run.steps] == ["micro_app-a1:install", "micro_app-a1:build"]
    assert [s.ref for s in node["micro_app-a1"].on_load.steps] == ["micro_app-a1:start", "micro_app-a1:present"]
    assert node["asset_setup:waha-container"].on_load is None, "a declared node loads only what it declares"


@pytest.mark.asyncio
async def test_the_whole_project_comes_up_leaf_first(project, monkeypatch, tmp_path):
    tree = await ProjectTree(project, ai=False).load()
    for name in ("server-op", "pair-op", "container-op"):
        tree.ops[name] = _stage_op(name)
    ran: list[str] = []
    installed: set[str] = set()

    async def shell(command, **_kw):
        verb, _, name = command.partition(" ")
        if verb == "install":
            ran.append(name)
            installed.add(name)
            return CliResult.of_process(command, 0)
        if verb == "have":
            return CliResult.of_process(command, 0 if name in installed else 1)
        return CliResult.of_process(command, 0)  # `flow credentials check`, `flow connections test`: they hold

    async def app_step(webapp, which, *, check, display=""):
        """Install and build have nothing to do; the app is not running until it is started."""
        if not check:
            ran.append(f"site:{which}")
            installed.add(f"site:{which}")
        held = which != "start" or "site:start" in installed
        return ReturnedValue(exit_code=ExitCode.OK if held else ExitCode.NOT_YET, ran=not check)

    monkeypatch.setattr(webapp_setup, "step", app_step)

    async def requirement_holds(project_id, which, *, check):
        """A connection's own needs (its credential, its provider) are there: this test is about order."""
        return True, ""

    monkeypatch.setattr(project_setup, "requirement_step", requirement_holds)
    recorded = []
    monkeypatch.setattr(derive, "_stage_recorder", lambda wizard, target: _recorder(recorded, wizard.name, target))
    tree = await ProjectTree(project, ai=False).load()
    for name in ("server-op", "pair-op", "container-op"):
        tree.ops[name] = _stage_op(name)

    result = await setup_tree(
        tree.root, resolve_node=tree.resolve_node, resolve_op=tree.resolve_op, workdir=tmp_path,
        shell=shell, platform="linux", approved=True, activity_path=f"setup-proj-{tmp_path.name}",
    )

    assert result.ok, result.detail
    assert ran == ["container-op", "server-op", "pair-op"], "setup does not execute operational on_load"
    assert recorded == [("waha-server-stage", "data_source-w1", True), ("waha-pair-stage", "data_source-w1", True)]


def _recorder(into, name, target):
    async def record(result):
        into.append((name, target, result.ok))

    return record


@pytest.mark.asyncio
async def test_without_approval_a_connectors_own_wizard_is_refused(project, tmp_path):
    tree = await ProjectTree(project, ai=False).load()

    async def shell(command, **_kw):
        return CliResult.of_process(command, 0)

    result = await setup_tree(tree.root, resolve_node=tree.resolve_node, resolve_op=tree.resolve_op,
                              workdir=tmp_path, shell=shell, platform="linux", activity_path=f"setup-u-{tmp_path.name}")
    assert result.state is SetupState.REFUSED and "waha-container" in result.detail


@pytest.mark.asyncio
async def test_a_declared_node_naming_a_missing_wizard_is_a_problem_not_a_pass(project, monkeypatch):
    monkeypatch.setattr(AssetSetup, "spec", lambda self: AssetSetupSpec(name="waha-container", run="no-such-wizard"))
    tree = await ProjectTree(project).load()
    assert tree.nodes["asset_setup:waha-container"].problem == "waha-container names the wizard 'no-such-wizard', which is not here"


def test_a_declared_setup_belongs_to_the_asset_folder_that_holds_it():
    assert _holder("/p/agentic-assets/data_driver/waha/agentic-assets/asset_setup/c") == "data_driver:waha"
    assert _holder("/p/agentic-assets/data_source/feed/asset_setup/c") == "data_source:feed"
    assert _holder("/p/agentic-assets/webapp/site/agentic-assets/asset_setup/c") == "webapp:site"
    assert _holder(str(Path("/p/agentic-assets/asset_setup/c"))) == "project"


@pytest.mark.asyncio
async def test_a_setup_declared_inside_a_web_app_is_what_opening_that_app_needs(project, monkeypatch):
    """An app ships what it needs in its own folder (Spora Admin: the project's Google Cloud credential), so
    opening THAT app waits on it — at the project root it held nothing the app's own load looked at."""
    monkeypatch.setattr(AssetSetup, "spec", lambda self: AssetSetupSpec(
        name="site-needs", children=["credential:stripe"]))
    inside = AssetSetup(name="site-needs", asset_ref="/p/agentic-assets/webapp/site/agentic-assets/asset_setup/site-needs")

    async def declared(_q):
        return [inside]

    monkeypatch.setattr(AssetSetup, "get_all", declared)
    tree = await ProjectTree(project).load()
    assert tree.nodes["micro_app-a1"].children == ("asset_setup:site-needs",)
    assert "asset_setup:site-needs" not in tree.nodes["project-p1"].children


@pytest.mark.asyncio
async def test_a_declared_load_wizard_resolves_like_the_other_two(project, monkeypatch):
    monkeypatch.setattr(AssetSetup, "spec", lambda self: AssetSetupSpec(name="waha-container", run="waha-container", on_load="waha-container"))
    tree = await ProjectTree(project).load()
    assert tree.nodes["asset_setup:waha-container"].on_load.name == "waha-container"


@pytest.mark.asyncio
async def test_a_declared_load_wizard_that_is_missing_is_a_problem_too(project, monkeypatch):
    monkeypatch.setattr(AssetSetup, "spec", lambda self: AssetSetupSpec(name="waha-container", on_load="no-such-warmer"))
    tree = await ProjectTree(project).load()
    assert tree.nodes["asset_setup:waha-container"].problem == "waha-container names the wizard 'no-such-warmer', which is not here"


@pytest.mark.asyncio
async def test_an_app_load_includes_project_and_attached_declarations(project, monkeypatch):
    monkeypatch.setattr(AssetSetup, "spec", lambda self: AssetSetupSpec(
        name="home-load", subject="micro_app-a1", on_load="waha-container"))
    app = SimpleNamespace(id="a1", name="site", typeid="micro_app-a1", asset_ref="/p/site", setup_skipped=None,
                          get_type=lambda: "micro_app")
    tree = await ProjectTree(project).load_one(app)
    assert "project-p1" in tree.nodes
    assert tree.nodes["micro_app-a1"].children == ("asset_setup:home-load",)
    assert tree.nodes["asset_setup:home-load"].on_load.name == "waha-container"


async def test_two_projects_shipping_one_wizard_name_resolve_to_the_nearer_copy(monkeypatch):
    """A dependency's own asset_setup runs ITS ``waha-setup``, not the same-named wizard a driver elsewhere ships."""
    from types import SimpleNamespace

    from flow_sdk.builtin import shipped_lookup

    ours = SimpleNamespace(asset_ref="/w/waha-service/agentic-assets/wizard/waha-setup", id=1)
    theirs = SimpleNamespace(asset_ref="/x/waha/agentic-assets/data_driver/waha/agentic-assets/wizard/waha-setup", id=2)

    class Rows:
        @staticmethod
        async def get_all(_):
            return [theirs, ours]

    monkeypatch.setattr(shipped_lookup, "is_running_install_path", lambda _: False)
    near = "/w/waha-service/agentic-assets/asset_setup/waha-service"
    assert await shipped_lookup.by_name_preferring_this_install(Rows, "waha-setup", near=near) is ours


@pytest.mark.asyncio
async def test_an_app_whose_folder_is_gone_is_not_something_to_set_up(monkeypatch, tmp_path):
    from flow_sdk.builtin.faas.micro_app import WebApp

    (tmp_path / "here").mkdir()
    rows = [WebApp(name="here", asset_ref=str(tmp_path / "here")),
            WebApp(name="gone", asset_ref=str(tmp_path / "old-install" / "gone")),
            WebApp(name="row-only")]

    async def get_all(_query):
        return rows

    monkeypatch.setattr(WebApp, "get_all", get_all)
    tree = ProjectTree(SimpleNamespace(id="p1", name="Shop", fs_storage_mount_path=str(tmp_path)))
    assert [app.name for app in await tree._webapps()] == ["here"]
