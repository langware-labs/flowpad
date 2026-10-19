"""Artifact source-origin persistence tests.

Git checkout/materialization behavior belongs to the FSOrigin driver.  Artifact
stores only the provider-neutral source pointer; it no longer owns a bespoke
``resolve-git-location`` action or sender-local runtime/path fields.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.fs_store.origin.git_origin import GitOrigin


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


@pytest.mark.asyncio
async def test_artifact_persists_git_origin_without_runtime_fields(bootstrapped_client, tmp_path):
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True, capture_output=True)
    repo = tmp_path / "repo"
    _git(tmp_path, "clone", "-q", remote.resolve().as_uri(), str(repo))
    _git(repo, "checkout", "-q", "-b", "feature/artifact-origin")
    _git(repo, "config", "user.email", "test@example.test")
    _git(repo, "config", "user.name", "Test")
    app_dir = repo / "apps" / "web"
    app_dir.mkdir(parents=True)
    (app_dir / "index.html").write_text("artifact origin token\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "webapp")

    origin = GitOrigin.for_asset_path(str(app_dir))
    assert origin is not None
    artifact = Artifact(
        id=mint_uuid(),
        name="resolver webapp",
        kind="application.web",
        description="A logical app",
        origin=origin,
    )
    await artifact.save(notify=False)

    response = await bootstrapped_client.get(f"/api/v1/graph/artifact/{artifact.id}")
    assert response.status_code == 200, response.text
    payload = response.json()["data"]
    assert payload["kind"] == "application.web"
    assert payload["origin"]["kind"] == "git"
    assert payload["origin"]["branch"] == "feature/artifact-origin"
    assert payload["origin"]["rel_path"] == "apps/web"
    for retired in ("artifact_type", "ref_type", "path", "port", "start_cmd", "health", "git_origin"):
        assert retired not in payload
