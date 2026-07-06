"""Artifact git-location resolver tests.

These tests run real git commands and call the real graph action endpoint. No
clone/pull functions are mocked here because this is the path the git setup
wizard retries after it has prepared a local checkout.
"""
from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.artifact import Artifact, ArtifactReferenceType, ArtifactType
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.project import Project


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.mark.asyncio
async def test_artifact_resolve_git_location_uses_wizard_checkout_path(bootstrapped_client, tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True, capture_output=True)

    repo = tmp_path / "repo"
    _git(tmp_path, "clone", "-q", remote.resolve().as_uri(), str(repo))
    _git(repo, "checkout", "-q", "-b", "feature/artifact-resolve")
    _git(repo, "config", "user.email", "test@example.test")
    _git(repo, "config", "user.name", "Test")
    app_dir = repo / "apps" / "web"
    app_dir.mkdir(parents=True)
    (app_dir / "index.html").write_text("artifact resolver token\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "webapp")
    _git(repo, "push", "-q", "-u", "origin", "feature/artifact-resolve")

    git_origin = GitOrigin.for_asset_path(str(app_dir))
    assert git_origin is not None

    artifact_id = str(uuid.uuid4())
    artifact = Artifact(
        id=artifact_id,
        name="resolver webapp",
        ref_type=ArtifactReferenceType.FOLDER,
        path="",
        artifact_type=ArtifactType.WEBAPP,
        port="45680",
        git_origin=git_origin,
    )
    await artifact.save(notify=False)

    empty_root = tmp_path / "empty-project"
    empty_root.mkdir()
    empty_project = Project(name="empty", fs_storage_mount_path=str(empty_root))
    await empty_project.save(notify=False)

    missing = await bootstrapped_client.post(
        f"/api/v1/graph/artifact/{artifact_id}/resolve-git-location",
        json={"current_project_id": empty_project.id},
    )
    assert missing.status_code == 200, missing.text
    assert missing.json()["data"]["kind"] == "needs_wizard"

    project = Project(name="repo", fs_storage_mount_path=str(repo))
    await project.save(notify=False)
    ready = await bootstrapped_client.post(
        f"/api/v1/graph/artifact/{artifact_id}/resolve-git-location",
        json={
            "current_project_id": empty_project.id,
            "local_path": str(repo),
            "project_id": project.id,
        },
    )
    assert ready.status_code == 200, ready.text
    data = ready.json()["data"]
    assert data["kind"] == "ready"
    assert Path(data["localPath"]).resolve() == app_dir.resolve()
    assert data["artifact"]["path"] == str(app_dir.resolve())
    assert data["artifact"]["project_id"] == project.id
