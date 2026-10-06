"""Project dependencies (``flow.json``) — every case and corner the resolver owns.

Real local git repositories over ``file://`` stand in for remotes (cloning is the step
under test; a stubbed clone would pin nothing). The hub is the one thing stubbed, at
``hub_get_or_raise``. Each test gets its own workspace, so a clone from one test can
never be "reused" by the next.

# do not increase timeout without approval
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

from flow_sdk.assets import flow_json
from flow_sdk.builtin import project_dependencies
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.data_spec.flow_json_spec import FlowJsonSpec, parse_source
from flow_sdk.schema.type_info import register_all
from tests.unit._project_names import unique_project_name

register_all()

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

AGENT_JSON = {"type": "agent", "name": "legal-agent", "title": "Legal agent", "worker_type": "claude", "enabled": True}


# ── fixtures ────────────────────────────────────────────────────────────────


def _git(cwd: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", *args],
        cwd=cwd, check=True, capture_output=True, text=True, timeout=20,
    )
    return out.stdout.strip()


def _repo(root: Path, files: dict[str, str] | None = None, *, branch: str = "main") -> str:
    """A committed repo at ``root``; returns its ``file://`` URL."""
    root.mkdir(parents=True, exist_ok=True)
    for rel, text in (files or {"README.md": "# repo\n"}).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    _git(root, "init", "-q", "-b", branch)
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", "seed")
    return f"file://{root}"


def _commit(root: Path, rel: str, text: str) -> str:
    (root / rel).write_text(text, encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-qm", f"edit {rel}")
    return _git(root, "rev-parse", "HEAD")


def _head(root: Path) -> str:
    return _git(root, "rev-parse", "HEAD")


def _tracked_changes(repo: Path) -> list[str]:
    status = subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True, timeout=20)
    return [line for line in status.stdout.splitlines() if not line.startswith("??")]


def _declare(root: Path, document: dict) -> None:
    (Path(root) / "flow.json").write_text(json.dumps(document, indent=2), encoding="utf-8")


async def _project(tmp_path: Path, name: str, *, git_url: str | None = None) -> Project:
    work = tmp_path / name
    if git_url:
        _git(tmp_path, "clone", "-q", git_url, str(work))
    else:
        work.mkdir()
    project = Project(name=unique_project_name(name), fs_storage_mount_path=str(work))
    await project.save()
    return project


def _state(states, name, via=None):
    return next(s for s in states if s.name == name and s.via == via)


@pytest.fixture(autouse=True)
def workspace(tmp_path, monkeypatch):
    """Clones land in this test's own workspace."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr("flow_sdk.fs_store.origin.git_origin._workspace", lambda: ws)
    project_dependencies._DISMISSED.clear()
    return ws


# ── the file ────────────────────────────────────────────────────────────────


def test_the_three_source_forms_parse():
    assert parse_source("git+https://github.com/langware-labs/langware-os#main").branch == "main"
    assert parse_source("hub:8c1f0b2e-1111-4111-8111-111111111111").kind == "hub"
    assert parse_source("file:~/notes").target == "~/notes"
    for bad in ("https://github.com/a/b", "git+not a url", "hub:not-an-id", "file:", "npm:x"):
        with pytest.raises(ValueError):
            parse_source(bad)


@pytest.mark.parametrize(
    "document, problem",
    [
        ({"dependencies": {"a": "file:/x"}, "optionalDependencies": {"a": "file:/y"}}, "both required and optional"),
        ({"dependencies": {"a b": "file:/x"}}, "not a dependency name"),
        ({"dependencies": {"a": {"source": "file:/x", "path": "../up"}}}, "must stay inside"),
        ({"dependencies": {"a": "npm:x"}}, "starts with git+"),
        ({"depends": {}}, "Extra inputs"),
        ({"alwaysUseSkills": "triage"}, "list of skill names"),
        ({"alwaysUseSkills": [f"s{i}" for i in range(9)]}, "at most 8"),
    ],
)
def test_a_wrong_file_is_refused_with_its_reason(document, problem):
    with pytest.raises(flow_json.FlowJsonError, match=problem):
        flow_json.parse(json.dumps(document))


def test_the_written_form_is_what_a_person_would_write(tmp_path):
    from flow_sdk.schema.data_spec.flow_json_spec import FlowDependency

    flow_json.write_dependency(tmp_path, FlowDependency(name="os", source="git+file:///r#main"))
    flow_json.write_dependency(tmp_path, FlowDependency(name="docs", source="file:/d", path="legal", required=False))
    assert json.loads((tmp_path / "flow.json").read_text()) == {
        "dependencies": {"os": "git+file:///r#main"},
        "optionalDependencies": {"docs": {"source": "file:/d", "path": "legal"}},
    }
    flow_json.drop_dependency(tmp_path, "docs")
    flow_json.drop_dependency(tmp_path, "nothing-here")
    assert json.loads((tmp_path / "flow.json").read_text()) == {"dependencies": {"os": "git+file:///r#main"}}


def test_dropping_from_no_file_never_creates_one(tmp_path):
    flow_json.drop_dependency(tmp_path, "x")
    assert not (tmp_path / "flow.json").exists()


def test_a_hand_broken_file_is_never_overwritten(tmp_path):
    from flow_sdk.schema.data_spec.flow_json_spec import FlowDependency

    (tmp_path / "flow.json").write_text("{ broken", encoding="utf-8")
    with pytest.raises(flow_json.FlowJsonError):
        flow_json.write_dependency(tmp_path, FlowDependency(name="x", source="file:/x"))
    assert (tmp_path / "flow.json").read_text() == "{ broken"


@pytest.mark.skipif(sys.platform != "win32", reason="a drive letter is only absolute on Windows")
def test_a_windows_file_path_is_absolute(tmp_path):
    from flow_sdk.schema.data_spec.flow_json_spec import expand_file_target

    assert expand_file_target("C:\\Users\\me\\notes", base=tmp_path).is_absolute()


# ── git ─────────────────────────────────────────────────────────────────────


async def test_a_git_dependency_is_cloned_linked_indexed_and_left_clean(tmp_path, workspace):
    url = _repo(tmp_path / "remote-os", {
        "agentic-assets/agent/legal-agent/agent.json": json.dumps(AGENT_JSON),
        "agentic-assets/agent/legal-agent/system_prompt.md": "Read docs/legal/guide.md first.\n",
        "docs/legal/guide.md": "# Guide\n",
    })
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"langware-os": f"git+{url}#main"}})

    states = await site.resolve_dependencies()

    os_dep = _state(states, "langware-os")
    assert os_dep.state == "ready", os_dep
    clone = Path(os_dep.local_path)
    assert clone.parent == workspace, "a missing repo is cloned into the workspace"
    assert os_dep.local_path in site.include_dirs and os_dep.local_path in site.context_roots
    agents = [a for a in await Agent.get_all({}) if a.asset_ref and Path(a.asset_ref).is_relative_to(clone)]
    assert agents, "the dependency's agent is indexed"
    assert _tracked_changes(clone) == [], "indexing a clone must leave it pullable"


async def test_one_repo_two_projects_one_clone(tmp_path):
    url = _repo(tmp_path / "remote")
    a, b = await _project(tmp_path, "a"), await _project(tmp_path, "b")
    for p in (a, b):
        _declare(Path(p.fs_storage_mount_path), {"dependencies": {"shared": f"git+{url}#main"}})
    first = _state(await a.resolve_dependencies(), "shared")
    second = _state(await b.resolve_dependencies(), "shared")
    assert first.local_path == second.local_path


async def test_adding_a_folder_in_git_records_the_repo_and_reuses_the_checkout(tmp_path, workspace):
    url = _repo(tmp_path / "remote", {"docs/legal/guide.md": "# g\n"})
    mine = tmp_path / "elsewhere" / "my-checkout"   # outside the workspace, where the user keeps it
    mine.parent.mkdir()
    _git(tmp_path, "clone", "-q", url, str(mine))
    site = await _project(tmp_path, "site")

    whole = await site.add_dependency(str(mine))
    part = await site.add_dependency(str(mine / "docs"), name="legal-docs", optional=True)

    declared = json.loads((Path(site.fs_storage_mount_path) / "flow.json").read_text())
    assert declared["dependencies"] == {"remote": f"git+{url}#main"}, "a folder in git is written as its repo, named after it"
    assert declared["optionalDependencies"] == {"legal-docs": {"source": f"git+{url}#main", "path": "docs"}}
    assert whole.local_path == canonical_posix_path(str(mine)), "the checkout the user added from is reused"
    assert part.local_path == canonical_posix_path(str(mine / "docs"))
    assert not any(workspace.iterdir()), "nothing was cloned"


async def test_a_checkout_you_made_is_never_pulled(tmp_path):
    remote = tmp_path / "remote"
    url = _repo(remote)
    mine = tmp_path / "mine"
    _git(tmp_path, "clone", "-q", url, str(mine))
    site = await _project(tmp_path, "site")
    await site.add_dependency(str(mine))
    before = _head(mine)
    _commit(remote, "README.md", "# v2\n")
    state = _state(await site.resolve_dependencies(update=True), "remote")
    assert state.local_path == canonical_posix_path(str(mine))
    assert _head(mine) == before, "a checkout the user made is never pulled"


async def test_a_clone_flowpad_made_is_fast_forwarded_on_update(tmp_path, monkeypatch):
    monkeypatch.setattr("flow_sdk.utils.git.find_local_repo_for_url", lambda _url: None)
    remote = tmp_path / "remote"
    url = _repo(remote)
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"remote": f"git+{url}#main"}})
    cloned = Path(_state(await site.resolve_dependencies(), "remote").local_path)
    upstream = _commit(remote, "README.md", "# v2\n")
    await site.resolve_dependencies()
    assert _head(cloned) != upstream, "without update nothing moves"
    await site.resolve_dependencies(update=True)
    assert _head(cloned) == upstream


async def test_a_clone_that_fails_is_unreachable_and_warned(tmp_path):
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"gone": f"git+file://{tmp_path}/no-such-repo#main"}})
    gone = _state(await site.resolve_dependencies(), "gone")
    assert gone.state == "unreachable" and "could not clone" in gone.reason
    assert site.include_dirs == []
    assert [w.name for w in await site.dependency_warnings()] == ["gone"]


async def test_a_checkout_on_another_branch_is_used_and_named(tmp_path):
    url = _repo(tmp_path / "remote")
    mine = tmp_path / "mine"
    _git(tmp_path, "clone", "-q", url, str(mine))
    _git(mine, "checkout", "-q", "-b", "dev")
    site = await _project(tmp_path, "site")
    state = await site.add_dependency(str(mine))
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"mine": f"git+{url}#main"}})
    state = _state(await site.resolve_dependencies(update=True), "mine")
    assert state.state == "ready"
    assert "branch dev" in (state.reason or "")


async def test_a_path_that_is_not_in_the_repo_is_invalid(tmp_path):
    url = _repo(tmp_path / "remote")
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"x": {"source": f"git+{url}#main", "path": "nope"}}})
    assert _state(await site.resolve_dependencies(), "x").state == "invalid"


# ── file ────────────────────────────────────────────────────────────────────


async def test_a_file_dependency_is_ready_or_missing(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"notes": f"file:{notes}", "lost": f"file:{tmp_path}/lost"}})
    states = await site.dependencies()
    assert _state(states, "notes").state == "ready"
    assert _state(states, "lost").state == "missing"
    assert canonical_posix_path(str(notes)) in site.include_dirs


async def test_a_dependency_inside_the_project_is_refused(tmp_path):
    site = await _project(tmp_path, "site")
    (Path(site.fs_storage_mount_path) / "sub").mkdir()
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"sub": "file:sub"}})
    state = _state(await site.dependencies(), "sub")
    assert state.state == "invalid" and "inside the project" in state.reason


async def test_a_project_cannot_depend_on_its_own_folder(tmp_path):
    site = await _project(tmp_path, "site")
    (Path(site.fs_storage_mount_path) / "sub").mkdir()
    for folder in (site.fs_storage_mount_path, str(Path(site.fs_storage_mount_path) / "sub")):
        with pytest.raises(ValueError, match="its own folder"):
            await site.add_dependency(folder)
    assert not (Path(site.fs_storage_mount_path) / "flow.json").exists(), "a refused add writes nothing"


async def test_the_same_source_declared_twice_is_named(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"notes": f"file:{notes}", "again": f"file:{notes}/"}})
    again = _state(await site.dependencies(), "again")
    assert again.state == "invalid" and "same source as 'notes'" in again.reason
    assert site.include_dirs == [canonical_posix_path(str(notes))]


# ── optional, remove, broken file ───────────────────────────────────────────


async def test_an_optional_dependency_waits_for_install(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"optionalDependencies": {"notes": f"file:{notes}"}})

    assert _state(await site.resolve_dependencies(), "notes").state == "not_installed"
    assert site.include_dirs == []
    assert await site.dependency_warnings() == [], "an optional one is never a warning"

    assert (await site.install_dependency("notes")).state == "ready"
    assert _state(await site.dependencies(), "notes").state == "ready", "an installed optional stays installed"


async def test_removing_a_dependency_unlinks_it_and_leaves_the_folder(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    (notes / "keep.md").write_text("x")
    site = await _project(tmp_path, "site")
    await site.add_dependency(str(notes))
    assert site.include_dirs
    await site.remove_dependency("notes")
    assert site.include_dirs == []
    assert (notes / "keep.md").exists()


async def test_editing_the_file_by_hand_is_picked_up_on_the_next_read(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(), b.mkdir()
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"a": f"file:{a}"}})
    await site.dependencies()
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"b": f"file:{b}"}})
    await site.dependencies()
    assert site.include_dirs == [canonical_posix_path(str(b))]


async def test_a_broken_file_reports_and_keeps_what_resolved(tmp_path):
    notes = tmp_path / "notes"
    notes.mkdir()
    site = await _project(tmp_path, "site")
    await site.add_dependency(str(notes))
    (Path(site.fs_storage_mount_path) / "flow.json").write_text('{"dependencies": [}', encoding="utf-8")
    states = await site.dependencies()
    assert [(s.name, s.state) for s in states] == [("flow.json", "invalid")]
    assert site.include_dirs == [canonical_posix_path(str(notes))], "a typo must not tear the context down"


async def test_old_context_links_are_dropped(tmp_path):
    """No legacy: a folder linked the old way (no ``flow.json`` entry) leaves the context."""
    from flow_sdk.builtin.folder import Folder

    old = tmp_path / "old"
    old.mkdir()
    site = await _project(tmp_path, "site")
    folder = await Folder.mint_for_path(canonical_posix_path(str(old)))
    site.add_shared_context_entities(folder.typeid, data={"path": canonical_posix_path(str(old)), "origin_kind": "local"})
    await site.save()
    assert site.include_dirs
    await site.dependencies()
    assert site.include_dirs == []


# ── transitive ──────────────────────────────────────────────────────────────


async def test_transitive_cycle_diamond_and_the_rules_for_a_graph_you_do_not_control(tmp_path):
    """site → os → {site (cycle), d}; site → c → d (diamond); os's optional and file: are not followed."""
    d_url = _repo(tmp_path / "remote-d")
    secret = tmp_path / "secret"
    secret.mkdir()
    site_url = _repo(tmp_path / "remote-site")
    c_url = _repo(tmp_path / "remote-c", {"flow.json": json.dumps({"dependencies": {"d": f"git+{d_url}#main"}})})
    os_url = _repo(tmp_path / "remote-os", {"flow.json": json.dumps({
        "dependencies": {"site": f"git+{site_url}#main", "d": f"git+{d_url}#main", "keys": f"file:{secret}"},
        "optionalDependencies": {"extra": f"git+{c_url}#main"},
    })})
    site = await _project(tmp_path, "site", git_url=site_url)
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"os": f"git+{os_url}#main", "c": f"git+{c_url}#main"}})

    states = await site.resolve_dependencies()
    ready = sorted((s.name, s.via) for s in states if s.state == "ready")

    assert ready == [("c", None), ("d", "os"), ("os", None)], "d resolved once; the cycle back to site is a no-op"
    assert _state(states, "keys", "os").state == "invalid", "a dependency's file: source is never mounted"
    assert canonical_posix_path(str(secret)) not in site.include_dirs
    assert not any(s.name == "extra" for s in states), "a dependency's optional dependencies are not followed"
    assert len(site.include_dirs) == 3


async def test_a_graph_bigger_than_the_cap_stops(tmp_path, monkeypatch):
    monkeypatch.setattr(project_dependencies, "MAX_NODES", 2)
    dirs = []
    for i in range(3):
        (tmp_path / f"d{i}").mkdir()
        dirs.append(tmp_path / f"d{i}")
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {f"d{i}": f"file:{d}" for i, d in enumerate(dirs)}})
    states = await site.dependencies()
    assert [s.state for s in states] == ["ready", "ready", "invalid"]


# ── hub ─────────────────────────────────────────────────────────────────────

HUB_ID = "8c1f0b2e-1111-4111-8111-111111111111"


@pytest.mark.parametrize(
    "status, says",
    [(0, "not reachable"), (401, "log in"), (403, "do not have access"), (404, "does not exist")],
)
async def test_a_hub_dependency_that_cannot_be_read_says_why(tmp_path, monkeypatch, status, says):
    from flow_sdk.cloud_client.shared.errors import HubError

    async def refuse(*_a, **_k):
        raise HubError(status, "no")

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", refuse)
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"policies": f"hub:{HUB_ID}"}})
    state = _state(await site.resolve_dependencies(), "policies")
    assert state.state == "unreachable" and says in state.reason


async def test_a_hub_project_backed_by_git_resolves(tmp_path, monkeypatch):
    url = _repo(tmp_path / "remote-policies", {"policies/index.md": "# p\n"})

    async def row(*_a, **_k):
        return {"id": HUB_ID, "git_origin": {"kind": "git", "provider": "file", "owner": str(tmp_path), "name": "remote-policies", "branch": "main"}}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get_or_raise", row)
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"policies": {"source": f"hub:{HUB_ID}", "path": "policies"}}})
    state = _state(await site.resolve_dependencies(), "policies")
    assert state.state == "ready", state
    assert state.local_path.endswith("/policies")
    assert _state(await site.dependencies(), "policies").state == "ready", "a status read keeps a hub dependency without the network"


# ── warnings, readiness, sharing ────────────────────────────────────────────


async def test_dismissing_a_warning_lasts_until_restart(tmp_path):
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"lost": f"file:{tmp_path}/lost"}})
    assert [w.name for w in await site.dependency_warnings()] == ["lost"]
    site.dismiss_dependency_warning("lost")
    assert await site.dependency_warnings() == []
    project_dependencies._DISMISSED.clear()   # a restart: the set is process memory
    assert [w.name for w in await site.dependency_warnings()] == ["lost"]


async def test_setup_readiness_counts_a_missing_required_dependency(tmp_path):
    from flow_sdk.builtin.project_setup import compile_setup, readiness_of

    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {
        "dependencies": {"lost": f"file:{tmp_path}/lost"},
        "optionalDependencies": {"maybe": f"file:{tmp_path}/maybe"},
    })
    readiness = await readiness_of(site)
    assert not readiness.ready
    assert [(r.kind, r.name) for r in readiness.to_do] == [("dependency", "lost")]
    wizard, ops = compile_setup(str(site.id), readiness.to_do)
    assert "dependency-lost" in ops


async def test_sharing_warns_only_for_a_required_local_folder(tmp_path):
    url = _repo(tmp_path / "remote")
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {
        "dependencies": {"repo": f"git+{url}#main", "notes": "file:~/notes"},
        "optionalDependencies": {"scratch": "file:~/scratch"},
    })
    assert site.share_warnings() == ["notes: file:~/notes is a folder on this machine; members will not have it"]


# ── agents from a dependency ────────────────────────────────────────────────


async def test_an_agent_from_a_dependency_runs_in_the_host_and_knows_its_home(tmp_path):
    url = _repo(tmp_path / "remote-os", {
        "agentic-assets/agent/legal-agent/agent.json": json.dumps(AGENT_JSON),
        "agentic-assets/agent/legal-agent/system_prompt.md": "Read docs/legal/guide.md first.\n",
        "docs/legal/guide.md": "# Guide\n",
    })
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"langware-os": f"git+{url}#main"}})
    os_root = _state(await site.resolve_dependencies(), "langware-os").local_path
    legal = next(a for a in await Agent.get_all({}) if a.asset_ref and a.asset_ref.startswith(os_root))

    assert await legal.home() == os_root
    session = await legal.use(project_id=str(site.id))

    assert session.project_id == str(site.id)
    assert canonical_posix_path(session.workdir) == canonical_posix_path(site.fs_storage_mount_path)
    assert os_root in session.additional_dirs
    assert f"Your own files are in {os_root}" in session.context_data["instructions"]


async def test_rows_in_a_dependency_that_is_a_project_stay_that_projects(tmp_path):
    url = _repo(tmp_path / "remote-os", {"agentic-assets/agent/legal-agent/agent.json": json.dumps(AGENT_JSON)})
    os_project = await _project(tmp_path, "langware-os", git_url=url)
    site = await _project(tmp_path, "site")
    await site.add_dependency(os_project.fs_storage_mount_path)
    legal = next(
        a for a in await Agent.get_all({})
        if a.asset_ref and a.asset_ref.startswith(canonical_posix_path(os_project.fs_storage_mount_path))
    )
    assert legal.project_id == str(os_project.id)
    assert await legal.home() == canonical_posix_path(os_project.fs_storage_mount_path)


# ── the other two declarations ──────────────────────────────────────────────


async def test_always_use_skills_and_autolaunch_journey_come_from_flow_json(tmp_path):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"alwaysUseSkills": ["triage-ticket"], "autolaunchJourney": "onboarding"})
    assert flow_json.read_autolaunch_journey(Path(site.fs_storage_mount_path)) == "onboarding"
    process = AgenticProcess(workdir=site.fs_storage_mount_path, pty_mode=False)
    assert "`triage-ticket`" in process._read_always_use_skills_block()


def test_an_empty_spec_writes_nothing():
    assert FlowJsonSpec().to_document() == {}
