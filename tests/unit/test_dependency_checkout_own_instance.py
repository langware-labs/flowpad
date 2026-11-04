"""A dependency resolves to THIS instance's checkout, never another instance's clone of the same URL.

``~/.claude/projects`` is machine-wide, so on stg-1 the URL lookup listed prod's
``~/Flowpad workspace/waha-service``; the dependency adopted it, and registering it as a
project collided with stg-1's own ``waha-service`` ("a project named ... already exists").
"""

import dataclasses
from pathlib import Path

import pytest

import flow_sdk.config as config
import flow_sdk.fs_store.indexer.functions._claude_projects as claude_projects
from flow_sdk.builtin.project_dependencies import _checkout_for
from flow_sdk.fs_store.origin.git_origin import GitOrigin
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.instance_settings import get_instance_settings
from tests.unit.conftest import git_cmd

URL = "https://github.com/acme/waha-service.git"


def _clone(path):
    path.mkdir(parents=True)
    git_cmd(path, "init", "-q", "-b", "main")
    git_cmd(path, "remote", "add", "origin", URL)
    return path


@pytest.fixture
def two_instances(tmp_path, monkeypatch):
    mine = _clone(tmp_path / "instances" / "stg" / "workspace" / "waha-service")
    prod = _clone(tmp_path / "Flowpad workspace" / "waha-service")
    settings = dataclasses.replace(get_instance_settings(), user_home=tmp_path)  # prod's root: <home>/Flowpad workspace
    monkeypatch.setattr("flow_sdk.instance_settings.get_instance_settings", lambda: settings)
    monkeypatch.setattr(config, "agent_workspace_root", lambda: mine.parent)
    return mine, prod


@pytest.mark.timeout(30)
def test_another_instances_clone_is_not_this_dependency(two_instances, monkeypatch):
    mine, prod = two_instances
    monkeypatch.setattr(claude_projects, "iter_claude_project_paths", lambda: iter([prod]))
    origin = GitOrigin.from_url(URL, branch="")
    assert _checkout_for(origin, cached=str(prod)) is None
    assert origin.next_clone_target().resolve() == mine.resolve()


@pytest.mark.timeout(30)
def test_this_instances_clone_is_picked_over_anothers(two_instances, monkeypatch):
    mine, prod = two_instances
    monkeypatch.setattr(claude_projects, "iter_claude_project_paths", lambda: iter([prod, mine]))
    origin = GitOrigin.from_url(URL, branch="")
    assert _checkout_for(origin, cached=str(prod)).resolve() == mine.resolve()


@pytest.mark.timeout(30)
async def test_a_link_left_on_another_instances_clone_resolves_to_this_instances(tmp_path, monkeypatch):
    """The live stg-1 shape: the project's dependency link still names prod's clone (written before
    resolution was confined). A status read must answer with this instance's own clone of the URL."""
    from tests.unit.test_project_dependencies import _declare, _git, _project, _repo, _state

    url = _repo(tmp_path / "remote")
    prod_ws, stg_ws = tmp_path / "Flowpad workspace", tmp_path / "instances" / "stg" / "workspace"
    prod_ws.mkdir()
    stg_ws.mkdir(parents=True)
    prod, mine = prod_ws / "remote", stg_ws / "remote"
    _git(tmp_path, "clone", "-q", url, str(prod))
    _git(tmp_path, "clone", "-q", url, str(mine))
    settings = dataclasses.replace(get_instance_settings(), user_home=tmp_path)
    monkeypatch.setattr("flow_sdk.instance_settings.get_instance_settings", lambda: settings)
    monkeypatch.setattr(claude_projects, "iter_claude_project_paths", lambda: iter([prod]))

    def be(ws):
        monkeypatch.setattr(config, "agent_workspace_root", lambda: ws)
        monkeypatch.setattr("flow_sdk.fs_store.origin.git_origin._workspace", lambda: ws)

    be(prod_ws)  # the link is written while prod's clone is this instance's
    site = await _project(tmp_path, "site")
    _declare(Path(site.fs_storage_mount_path), {"dependencies": {"remote": f"git+{url}#main"}})
    assert _state(await site.resolve_dependencies(), "remote").local_path == canonical_posix_path(str(prod))

    be(stg_ws)  # the same rows, read by stg
    state = _state(await site.check_dependency_updates(), "remote")
    assert state.state == "ready"
    assert state.local_path == canonical_posix_path(str(mine))
