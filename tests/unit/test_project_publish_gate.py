"""Linking a Project to the cloud needs a signed-in actor and a cloud login — nothing else.

Its published assets travel through the project's hub-hosted repository, so the
folder's own git state never blocks: it need not be a checkout, have a remote,
be clean, or have GitHub connected. When the folder IS a clean, pushed checkout
its ``GitOrigin`` is returned as an informational pointer.
"""
from pathlib import Path

import pytest

from flow_sdk.app.actions.project_publish import ProjectPublishBlocked, assert_project_publishable
from tests.unit.agent._seed import seed_project
from tests.unit.conftest import git_cmd

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ACTOR = "user-3f1a9c2e-5b6d-4e7f-8a90-1b2c3d4e5f60"


@pytest.fixture
def logged_in(monkeypatch):
    """The cloud login is the one collaborator that needs a live hub; everything
    else (the project row, its folder, git) is real."""
    state = {"key": "hub-key"}
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.resolve_hub_api_key", lambda **_: state["key"])
    return state


async def test_a_plain_folder_links_without_any_git(tmp_path: Path, logged_in):
    project = await seed_project(tmp_path / "plain")

    assert await assert_project_publishable(project, ACTOR) is None


async def test_a_dirty_checkout_still_links(git_remote, logged_in):
    repo = git_remote.make_checkout(github_url="https://github.com/teacher/ai-course.git")
    project = await seed_project(repo)
    (repo / "uncommitted.md").write_text("work in progress\n", encoding="utf-8")

    assert await assert_project_publishable(project, ACTOR) is None


async def test_a_clean_pushed_checkout_advertises_its_origin(git_remote, logged_in):
    repo = git_remote.make_checkout(github_url="https://github.com/teacher/ai-course.git")
    project = await seed_project(repo)
    git_cmd(repo, "add", "-A")
    if git_cmd(repo, "status", "--porcelain"):
        git_cmd(repo, "commit", "-q", "-m", "project files")
    git_cmd(repo, "push", "-q", "origin", "main")

    origin = await assert_project_publishable(project, ACTOR)

    assert origin is not None
    assert (origin.provider, origin.owner, origin.name, origin.branch) == ("github", "teacher", "ai-course", "main")


async def test_an_anonymous_actor_is_refused(tmp_path: Path, logged_in):
    project = await seed_project(tmp_path / "anon")

    with pytest.raises(ProjectPublishBlocked) as excinfo:
        await assert_project_publishable(project, None)

    assert (excinfo.value.code, excinfo.value.status_code) == ("authenticated_user_required", 401)


async def test_a_missing_cloud_login_is_refused(tmp_path: Path, logged_in):
    logged_in["key"] = None
    project = await seed_project(tmp_path / "offline")

    with pytest.raises(ProjectPublishBlocked) as excinfo:
        await assert_project_publishable(project, ACTOR)

    assert (excinfo.value.code, excinfo.value.status_code) == ("cloud_login_required", 401)
