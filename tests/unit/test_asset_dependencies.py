"""Asset dependencies by id — an asset's ``flow.json`` names what it needs; including it brings the rest.

Folder data sources stand in for the layered knowledge case: a personal source depends on its
team's, the team's on the company's. Each lives in its own project (as it would on the hub); the
project that depends on the personal one gets all three folders in its context, or a state saying
which link is missing. The hub is the one thing stubbed (``resolve.hub_lookup`` and the project
fetch), everything else is the real resolver over real rows and files.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.assets import flow_json
from flow_sdk.builtin import project_dependencies
from flow_sdk.builtin.project import Project
from flow_sdk.dependencies import resolve as dep_resolve
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.data_spec.flow_json_spec import AssetFlowJsonSpec, FlowDependency, FlowJsonSpec
from flow_sdk.schema.type_info import register_all
from tests.unit._project_names import unique_project_name

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


# ── fixtures ────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean(tmp_path, monkeypatch):
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr("flow_sdk.fs_store.origin.git_origin._workspace", lambda: ws)
    project_dependencies._DISMISSED.clear()
    project_dependencies._LAST_FAILURE.clear()

    async def nobody(_typeid):
        return None  # the hub knows nothing unless a test says otherwise — and is never really asked

    monkeypatch.setattr(dep_resolve, "hub_lookup", nobody)


async def _project(tmp_path: Path, name: str) -> Project:
    work = tmp_path / name
    work.mkdir()
    project = Project(name=unique_project_name(name), fs_storage_mount_path=str(work))
    await project.save()
    return project


async def _source(tmp_path: Path, project: Project, name: str, files: dict[str, str] | None = None, **authored):
    """A folder source owned by ``project``, watching its own tree under ``tmp_path/trees``."""
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.ingest.reflect import ReflectMode

    tree = tmp_path / "trees" / name
    tree.mkdir(parents=True)
    for rel, text in (files or {f"{name}.md": f"# {name}\n"}).items():
        (tree / rel).write_text(text, encoding="utf-8")
    driver = await DataDriver.get("folder")
    src = driver.create_source(
        driver.create_config(root=str(tree)), name=name, reflect=ReflectMode.NONE.value, project_id=str(project.id),
        **authored,
    )
    await src.save()
    assert src.asset_ref and Path(src.asset_ref).is_dir(), "a source is a folder asset in its project"
    return src


def _depends(asset, document: dict) -> None:
    (Path(asset.asset_ref) / "flow.json").write_text(json.dumps(document, indent=2), encoding="utf-8")


def _declare(project: Project, document: dict) -> None:
    (Path(project.fs_storage_mount_path) / "flow.json").write_text(json.dumps(document, indent=2), encoding="utf-8")


def _canon(path) -> str:
    return canonical_posix_path(str(path))


def _by_name(states, name):
    return next(s for s in states if s.name == name)


async def _layers(tmp_path):
    """company ← team ← personal, each in its own project; returns (sources, projects)."""
    company_p, team_p, me_p = [await _project(tmp_path, n) for n in ("company-kb", "sales-kb", "dana-kb")]
    company = await _source(tmp_path, company_p, "company")
    team = await _source(tmp_path, team_p, "team")
    personal = await _source(tmp_path, me_p, "personal")
    _depends(team, {"dependencies": {"company-kb": {"ref": str(company.typeid), "name": "Company knowledge"}}})
    _depends(personal, {"dependencies": {"team-kb": str(team.typeid)}})
    return (personal, team, company), (me_p, team_p, company_p)


# ── the layered case ────────────────────────────────────────────────────────


async def test_depending_on_the_personal_source_brings_team_and_company(tmp_path):
    (personal, team, company), _ = await _layers(tmp_path)
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"me": str(personal.typeid)}})

    states = await site.resolve_dependencies()

    assert [(s.name, s.state, s.via_path) for s in states] == [
        ("me", "ready", []),
        ("team-kb", "ready", ["me"]),
        ("company-kb", "ready", ["me", "team-kb"]),
    ]
    assert _by_name(states, "company-kb").label == "Company knowledge"
    assert _by_name(states, "team-kb").typeid == str(team.typeid)
    roots = {_canon(src.files_root) for src in (personal, team, company)}
    assert roots <= set(site.include_dirs), "each source's FILES are in context, not its asset folder"


async def test_a_project_asset_that_declares_dependencies_brings_them(tmp_path):
    """The project need not name anything: an asset it holds depends on the rest."""
    (personal, team, company), (me_p, _, _) = await _layers(tmp_path)

    states = await me_p.resolve_dependencies()

    assert [(s.name, s.state, s.via_path) for s in states] == [
        ("team-kb", "ready", ["data_source/personal"]),
        ("company-kb", "ready", ["data_source/personal", "team-kb"]),
    ]
    assert {_canon(team.files_root), _canon(company.files_root)} <= set(me_p.include_dirs)


async def test_a_missing_link_says_which_one_and_where_it_was_needed(tmp_path):
    (personal, team, company), _ = await _layers(tmp_path)
    gone = str(company.typeid)
    await company.delete()
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"me": str(personal.typeid)}})

    states = await site.resolve_dependencies()

    missing = _by_name(states, "company-kb")
    assert (missing.state, missing.via_path, missing.source) == ("not_found", ["me", "team-kb"], gone)
    assert [s.name for s in project_dependencies.warnings_for(str(site.id), states)] == ["company-kb"]
    assert _canon(team.files_root) in site.include_dirs, "the links that did resolve are still in context"


async def test_a_status_read_never_asks_the_hub(tmp_path, monkeypatch):
    async def never(_typeid):
        raise AssertionError("a status read asked the hub")

    monkeypatch.setattr(dep_resolve, "hub_lookup", never)
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"x": "data_source-3b0c1d7e-2222-4222-8222-222222222222"}})

    states = await site.dependencies()

    assert (states[0].state, states[0].reason) == ("missing", "not on this machine — sync to look it up on the hub")


# ── graph shapes ────────────────────────────────────────────────────────────


async def test_cycle_diamond_and_a_dependencys_optional_entries(tmp_path):
    p = await _project(tmp_path, "graph")
    a, b, c, d, extra = [await _source(tmp_path, p, n) for n in ("a", "b", "c", "d", "extra")]
    _depends(a, {"dependencies": {"b": str(b.typeid), "c": str(c.typeid)}})
    _depends(b, {"dependencies": {"d": str(d.typeid), "back": str(a.typeid)}})   # a cycle
    _depends(c, {"dependencies": {"d": str(d.typeid)}, "optionalDependencies": {"extra": str(extra.typeid)}})
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"a": str(a.typeid)}})

    states = await site.resolve_dependencies()

    assert sorted((s.name, tuple(s.via_path)) for s in states if s.state == "ready") == [
        ("a", ()), ("b", ("a",)), ("c", ("a",)), ("d", ("a", "b")),
    ], "d once (diamond); the cycle back to a is a no-op; c's optional entry is c's choice, not ours"
    assert _canon(extra.files_root) not in site.include_dirs


async def test_an_optional_id_is_brought_in_only_when_installed(tmp_path):
    p = await _project(tmp_path, "opt")
    icp = await _source(tmp_path, p, "icp")
    site = await _project(tmp_path, "site")
    _declare(site, {"optionalDependencies": {"icp": str(icp.typeid)}})

    assert (await site.resolve_dependencies())[0].state == "not_installed"
    assert (await site.install_dependency("icp")).state == "ready"
    assert _canon(icp.files_root) in site.include_dirs


async def test_more_than_max_nodes_stops(tmp_path, monkeypatch):
    monkeypatch.setattr(project_dependencies, "MAX_NODES", 2)
    p = await _project(tmp_path, "big")
    sources = [await _source(tmp_path, p, f"s{i}") for i in range(3)]
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {f"s{i}": str(s.typeid) for i, s in enumerate(sources)}})

    states = await site.resolve_dependencies()

    assert [s.state for s in states] == ["ready", "ready", "invalid"]


# ── the file and the ids ────────────────────────────────────────────────────


async def test_a_kind_id_of_an_asset_type_is_the_same_asset(tmp_path):
    p = await _project(tmp_path, "k")
    src = await _source(tmp_path, p, "kb")
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"kb": f"data_source.id.{src.id}"}})

    states = await site.resolve_dependencies()

    assert (states[0].state, states[0].typeid) == ("ready", str(src.typeid))
    assert _canon(src.files_root) in site.include_dirs


async def test_a_project_is_a_dependency_by_its_id(tmp_path):
    other = await _project(tmp_path, "other")
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"other": str(other.typeid)}})

    states = await site.resolve_dependencies()

    assert states[0].state == "ready"
    assert _canon(other.fs_storage_mount_path) in site.include_dirs


async def test_an_asset_file_takes_ids_only_and_a_broken_one_is_named(tmp_path):
    p = await _project(tmp_path, "bad")
    src = await _source(tmp_path, p, "s")
    _depends(src, {"dependencies": {"home": "file:~/"}})

    states = await p.resolve_dependencies()

    assert [(s.name, s.state) for s in states] == [("data_source/s", "invalid")]
    assert "not a location" in states[0].reason
    with pytest.raises(flow_json.FlowJsonError):
        flow_json.write_dependency(Path(src.asset_ref), FlowDependency(name="x", source="file:/tmp"), AssetFlowJsonSpec)


async def test_writing_an_entry_keeps_its_name_and_description(tmp_path):
    p = await _project(tmp_path, "w")
    a, b = await _source(tmp_path, p, "a"), await _source(tmp_path, p, "b")
    dep = FlowDependency(name="b", source=str(b.typeid), label="Team B", description="what B knows")

    flow_json.write_dependency(Path(a.asset_ref), dep, AssetFlowJsonSpec)

    on_disk = json.loads((Path(a.asset_ref) / "flow.json").read_text())
    assert on_disk == {"dependencies": {"b": {"ref": str(b.typeid), "name": "Team B", "description": "what B knows"}}}
    assert flow_json.read(Path(a.asset_ref), AssetFlowJsonSpec).find("b") == dep


def test_the_root_file_is_the_asset_file_plus_what_only_a_project_says():
    assert issubclass(FlowJsonSpec, AssetFlowJsonSpec)
    assert set(AssetFlowJsonSpec.model_fields) == {"dependencies", "optional_dependencies"}
    with pytest.raises(ValueError):
        AssetFlowJsonSpec.model_validate({"alwaysUseSkills": ["x"]})


async def test_a_single_file_asset_never_declares(tmp_path):
    """Only ``agentic-assets/<family>/<name>/flow.json`` is read; a file beside a markdown is not."""
    p = await _project(tmp_path, "md")
    notes = Path(p.fs_storage_mount_path) / "agentic-assets" / "markdown"
    notes.mkdir(parents=True)
    (notes / "note.md").write_text("# note\n")
    (notes / "flow.json").write_text(json.dumps({"dependencies": {"x": "data_source-3b0c1d7e-2222-4222-8222-222222222222"}}))

    assert await p.resolve_dependencies() == []


# ── the hub ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "status, state, says",
    [(403, "unreachable", "do not have access"), (404, "not_found", "nothing on this machine or on the hub"),
     (0, "unreachable", "not reachable")],
)
async def test_an_id_the_hub_cannot_give_says_why(tmp_path, monkeypatch, status, state, says):
    from flow_sdk.cloud_client.shared.errors import HubError

    async def refuse(_typeid):
        raise HubError(status, "no")

    monkeypatch.setattr(dep_resolve, "hub_lookup", refuse)
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"x": "data_source-3b0c1d7e-2222-4222-8222-222222222222"}})

    states = await site.resolve_dependencies()

    assert states[0].state == state and says in states[0].reason


async def test_an_id_found_on_the_hub_is_fetched_with_its_project(tmp_path, monkeypatch):
    """The hub names the project holding the id; fetching that project here makes the id local."""
    wanted_id = "3b0c1d7e-2222-4222-8222-222222222222"
    asked: list[str] = []
    fetched: dict = {}

    async def lookup(typeid):
        asked.append(typeid)
        return "8c1f0b2e-1111-4111-8111-111111111111"

    async def fetch_hub_project(dep, project_id, *, fetch, update, cloned):
        # What a fetch leaves behind: the hub project on this machine, holding the source under ITS id.
        team_p = await _project(tmp_path, "hub-team")
        fetched["src"] = await _source(tmp_path, team_p, "hubteam", id=wanted_id)
        return project_dependencies._Found(None, team_p.fs_storage_mount_path, "hub_repo", True)

    monkeypatch.setattr(dep_resolve, "hub_lookup", lookup)
    monkeypatch.setattr(project_dependencies, "_hub", fetch_hub_project)
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"team": f"data_source-{wanted_id}"}})

    assert (await site.dependencies())[0].state == "missing", "a status read does not fetch"
    states = await site.resolve_dependencies()

    assert asked == [f"data_source-{wanted_id}"]
    assert (states[0].state, states[0].typeid) == ("ready", f"data_source-{wanted_id}")
    assert _canon(fetched["src"].files_root) in site.include_dirs


# ── verbs and setup ─────────────────────────────────────────────────────────


async def test_add_dependency_by_id_into_the_project_or_into_one_of_its_assets(tmp_path):
    (personal, team, company), (me_p, _, _) = await _layers(tmp_path)
    extra_p = await _project(tmp_path, "extra-kb")
    extra = await _source(tmp_path, extra_p, "extra")

    state = await me_p.add_dependency(str(extra.typeid), asset=str(personal.typeid), label="Extra", optional=False)

    assert (state.state, state.via, state.label) == ("ready", "data_source/personal", "Extra")
    declared = flow_json.read(Path(personal.asset_ref), AssetFlowJsonSpec)
    assert [e.source for e in declared.entries()] == [str(team.typeid), str(extra.typeid)]
    assert not (Path(me_p.fs_storage_mount_path) / "flow.json").exists(), "the project's own file is untouched"

    direct = await me_p.add_dependency(f"data_source.id.{company.id}", name="co")
    assert (direct.state, direct.via) == ("ready", None)
    with pytest.raises(ValueError, match="not a location"):
        await me_p.add_dependency("file:/tmp", asset=str(personal.typeid))


async def test_setup_counts_a_missing_link_however_deep_and_checks_it_by_id(tmp_path):
    from flow_sdk.builtin.project_setup import compile_setup, readiness_of

    (personal, team, company), _ = await _layers(tmp_path)
    gone = str(company.typeid)
    await company.delete()
    site = await _project(tmp_path, "site")
    _declare(site, {"dependencies": {"me": str(personal.typeid)}})

    readiness = await readiness_of(site)

    assert [(r.kind, r.name) for r in readiness.to_do] == [("dependency", gone)]
    _wizard, ops = compile_setup(str(site.id), readiness.to_do)
    op = ops[f"dependency-{gone}"]
    assert gone in json.dumps(op.model_dump(mode="json")["completion_check"]), "flow dep check <the id>"
    states = await site.dependencies()
    deep = next(s for s in states if project_dependencies.requirement_key(s) == gone)
    assert deep.via_path == ["me", "team-kb"]


async def test_an_optional_declared_by_a_project_asset_stays_installed(tmp_path):
    """Installed once, it is remembered: the next status read still finds it ready and linked."""
    p = await _project(tmp_path, "own-opt")
    holder = await _source(tmp_path, p, "holder")
    elsewhere = await _project(tmp_path, "elsewhere")
    extra = await _source(tmp_path, elsewhere, "extra")
    _depends(holder, {"optionalDependencies": {"extra": str(extra.typeid)}})

    assert (await p.dependencies())[0].state == "not_installed"
    await project_dependencies.resolve(p, fetch=True, install=["extra"])

    assert (await p.dependencies())[0].state == "ready"
    assert _canon(extra.files_root) in p.include_dirs


async def test_a_skill_folder_declares_too(tmp_path):
    """Folder assets are found where their type is placed — not only under ``agentic-assets/``."""
    p = await _project(tmp_path, "skilled")
    other = await _project(tmp_path, "kb")
    kb = await _source(tmp_path, other, "kb")
    skill = Path(p.fs_storage_mount_path) / ".claude" / "skills" / "answer"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("---\nname: answer\ndescription: answers from the kb\n---\n")
    (skill / "flow.json").write_text(json.dumps({"dependencies": {"kb": str(kb.typeid)}}))

    states = await p.resolve_dependencies()

    assert [(s.name, s.state, s.via_path) for s in states] == [("kb", "ready", ["skills/answer"])]
    assert _canon(kb.files_root) in p.include_dirs
