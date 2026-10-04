"""``POST project/<id>/share`` — linking a Project to the cloud.

Only a signed-in actor and a cloud login are required: the project's assets
travel through its hub-hosted repository, so the folder need not be a git
checkout. A clean, pushed checkout still advertises its ``GitOrigin``.

``Project.share`` (the hub round trip) and the cloud-login lookup are the only
stand-ins; the project row, its folder and git are real.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project

PUBLISHED_AT = "2026-08-03T12:00:00+00:00"
GITHUB_URL = "https://github.com/flowpad-test/published-project.git"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


async def _create_project(client, root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    response = await client.post(
        "/api/v1/graph/project",
        json={"type": "project", "name": root.name, "fs_storage_mount_path": str(root)},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


def _clean_pushed_checkout(tmp_path: Path, root: Path) -> None:
    """``root`` becomes a checkout of a GitHub URL (rewritten to a local bare repo), clean and pushed."""
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(remote))
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.name", "Test User")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", f"url.{remote.as_uri()}.insteadOf", GITHUB_URL)
    _git(root, "remote", "add", "origin", GITHUB_URL)
    (root / "README.md").write_text("seed\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "initial")
    _git(root, "push", "-q", "-u", "origin", "main")


@pytest.fixture
def linking(monkeypatch):
    state = {"key": "hub-key", "shared": 0}

    async def _share(self: Project, invitees=None, *, teams=None, note=None, via=None) -> Project:  # noqa: ARG001
        state["shared"] += 1
        self.remote = True
        self.hub_published_at = PUBLISHED_AT
        return self

    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.resolve_hub_api_key", lambda **_: state["key"])
    monkeypatch.setattr(Project, "share", _share)
    return state


@pytest.mark.asyncio
async def test_linking_without_a_cloud_login_is_refused(bootstrapped_client, tmp_path, linking) -> None:
    linking["key"] = None
    project = await _create_project(bootstrapped_client, tmp_path / "publish-login-gate")

    response = await bootstrapped_client.post(f"/api/v1/graph/project/{project['id']}/share", json={})

    assert response.status_code == 401
    assert response.json()["data"]["code"] == "cloud_login_required"
    assert linking["shared"] == 0


@pytest.mark.asyncio
async def test_a_folder_that_is_not_a_git_repo_links(bootstrapped_client, tmp_path, linking) -> None:
    root = tmp_path / "publish-plain"
    project = await _create_project(bootstrapped_client, root)

    response = await bootstrapped_client.post(f"/api/v1/graph/project/{project['id']}/share", json={})

    assert response.status_code == 200, response.text
    assert not (root / ".git").exists()
    assert response.json()["data"]["remote"] is True
    persisted = await Project._db.get_by_id(project["id"], Project.get_type())
    assert persisted.remote is True
    assert persisted.hub_published_at == PUBLISHED_AT
    assert getattr(persisted.origin, "kind", None) != "git"


@pytest.mark.asyncio
async def test_a_clean_checkout_links_and_persists_its_origin(bootstrapped_client, tmp_path, linking) -> None:
    root = tmp_path / "publish-canonical"
    project = await _create_project(bootstrapped_client, root)
    _clean_pushed_checkout(tmp_path, root)
    head = _git(root, "rev-parse", "HEAD")

    response = await bootstrapped_client.post(f"/api/v1/graph/project/{project['id']}/share", json={})

    assert response.status_code == 200, response.text
    canonical = response.json()["data"]
    assert canonical["id"] == project["id"]
    assert canonical["remote"] is True
    assert canonical["hub_published_at"] == PUBLISHED_AT
    expected = {"provider": "github", "owner": "flowpad-test", "name": "published-project", "branch": "main"}
    assert {k: canonical["origin"][k] for k in expected} == expected
    assert canonical["origin"]["head_commit"] == head

    persisted = await Project._db.get_by_id(project["id"], Project.get_type())
    assert persisted.remote is True
    assert persisted.origin.model_dump(mode="json") == canonical["origin"]
