"""A dependency resolves to THIS instance's checkout, never another instance's clone of the same URL.

``~/.claude/projects`` is machine-wide, so on stg-1 the URL lookup listed prod's
``~/Flowpad workspace/waha-service``; the dependency adopted it, and registering it as a
project collided with stg-1's own ``waha-service`` ("a project named ... already exists").
"""

import dataclasses

import pytest

import flow_sdk.config as config
import flow_sdk.fs_store.indexer.functions._claude_projects as claude_projects
from flow_sdk.builtin.project_dependencies import _checkout_for
from flow_sdk.fs_store.origin.git_origin import GitOrigin
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
