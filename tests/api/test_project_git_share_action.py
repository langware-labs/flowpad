"""``project/<id>/git_share`` on the desk — the route the TS SDK and the project page call.

Through the real local HTTP route; the hub's answers are played by ``HubDouble``.
GET reports, POST shares (or names GitHub's next step), DELETE stops sharing, and
a project the desk can see is not shareable is refused before the hub is asked.
"""

from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from tests.utils.git_share_hub_double import HubDouble

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def _project(root: Path, *, remote: bool = True) -> Project:
    root.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=root, check=True)
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/acme/api.git"], cwd=root, check=True)
    project = Project(name=f"api-{uuid.uuid4().hex[:6]}", fs_storage_mount_path=str(root.resolve()))
    project.remote = remote
    await project.save()
    return project


def _url(project: Project) -> str:
    return f"/api/v1/graph/project/{project.id}/git_share"


async def test_get_post_delete_round_trip(bootstrapped_client, tmp_path, monkeypatch):
    project = await _project(tmp_path / "api")
    hub = HubDouble(str(project.id)).install(monkeypatch)

    status = await bootstrapped_client.get(_url(project))
    assert status.status_code == 200, status.text
    assert status.json()["data"]["status"] == "not_shared"

    shared = await bootstrapped_client.post(_url(project), json={})
    assert shared.status_code == 200, shared.text
    data = shared.json()["data"]
    assert (data["status"], data["repo"], data["clone_url"]) == ("shared", "acme/api", hub.clone_url)
    assert hub.git_origin["kind"] == "hub_repo", "recipients now clone through the hub"

    stopped = await bootstrapped_client.delete(_url(project))
    assert stopped.status_code == 200, stopped.text
    assert stopped.json()["data"]["status"] == "not_shared"
    assert [c[0] for c in hub.calls] == ["GET", "POST", "PUT", "DELETE", "PUT"]


async def test_the_next_github_step_comes_back_as_data(bootstrapped_client, tmp_path, monkeypatch):
    project = await _project(tmp_path / "api")
    HubDouble(str(project.id), answer="install_required").install(monkeypatch)
    response = await bootstrapped_client.post(_url(project), json={})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "install_required"
    assert response.json()["data"]["install_url"].endswith("/installations/new")


async def test_an_unlinked_project_is_refused_before_the_hub(bootstrapped_client, tmp_path, monkeypatch):
    project = await _project(tmp_path / "local", remote=False)
    hub = HubDouble(str(project.id)).install(monkeypatch)
    response = await bootstrapped_client.post(_url(project), json={})
    assert response.status_code == 409, response.text
    assert response.json()["data"]["error_code"] == "git_share_not_shareable"
    assert "Link the project to the cloud first" in response.json()["message"]
    assert hub.calls == []
