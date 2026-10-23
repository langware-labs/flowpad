"""``find_local_repo_for_url`` never adopts a checkout inside another Flowpad instance's folder.

``~/.claude/projects`` is machine-wide, so every instance on the machine lists every other
instance's workspace checkouts. Adopting one made a shared project's member install land in
the editor's clone (``project_invite_members`` e2e).
"""

import pytest

from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.utils import git as git_utils
from tests.unit.conftest import git_cmd

URL = "https://github.com/acme/course.git"


def _checkout(path):
    path.mkdir(parents=True)
    git_cmd(path, "init", "-q", "-b", "main")
    git_cmd(path, "remote", "add", "origin", URL)
    return path


@pytest.fixture
def instances(tmp_path, monkeypatch):
    settings = get_instance_settings()
    monkeypatch.setattr(type(settings), "instances_root", property(lambda self: tmp_path / "instances"))
    monkeypatch.setattr(type(settings), "instance_dir", property(lambda self: tmp_path / "instances" / "me"))
    return tmp_path / "instances"


def _listed(monkeypatch, *paths):
    import flow_sdk.fs_store.indexer.functions._claude_projects as claude_projects

    monkeypatch.setattr(claude_projects, "iter_claude_project_paths", lambda: iter(paths))


def test_another_instances_checkout_is_skipped(instances, monkeypatch):
    other = _checkout(instances / "other" / "workspace" / "course")
    _listed(monkeypatch, other)
    assert git_utils.find_local_repo_for_url(URL) is None


def test_this_instances_checkout_is_found(instances, monkeypatch):
    mine = _checkout(instances / "me" / "workspace" / "course")
    _listed(monkeypatch, mine)
    assert git_utils.find_local_repo_for_url(URL) == str(mine)


def test_a_checkout_outside_every_instance_is_found(tmp_path, instances, monkeypatch):
    user_clone = _checkout(tmp_path / "code" / "course")
    _listed(monkeypatch, user_clone)
    assert git_utils.find_local_repo_for_url(URL) == str(user_clone)
