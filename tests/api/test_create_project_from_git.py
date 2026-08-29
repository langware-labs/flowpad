"""API tests for the create-project-from-git action on ComputeNode.

git_clone is mocked at the call site (the action imports it from
flow_sdk.utils.git inside the function body) — the mock writes a sentinel
file at target_dir so the rest of the flow can run without hitting a real
remote.
"""
from pathlib import Path
from unittest.mock import patch

import pytest

from flow_sdk.config import AGENT_MOUNT_FOLDER
from flow_sdk.fs_store.origin.git_origin import GitOrigin


def _cn_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


def _origin(url: str, branch: str = "") -> dict:
    git_origin = GitOrigin.from_url(url, branch=branch, rel_path=".")
    assert git_origin is not None
    return git_origin.model_dump(mode="json")


#: kwargs the last _fake_git_clone call saw — lets a test assert on how the
#: action invoked git without wrapping the fake again.
last_clone: dict = {}


async def _fake_git_clone(clone_url: str, target_dir: str, branch=None, token=None):
    last_clone.update(clone_url=clone_url, target_dir=target_dir, branch=branch, token=token)
    Path(target_dir).mkdir(parents=True, exist_ok=False)
    (Path(target_dir) / "README.md").write_text(f"cloned from {clone_url}")
    return True, "Cloned successfully."


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_create_project_from_git_happy_path(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    target = Path(AGENT_MOUNT_FOLDER) / "Hello-World"
    if target.exists():
        # Sandboxed HOME — but be defensive against parallel-test leakage.
        import shutil
        shutil.rmtree(target)

    with patch("flow_sdk.utils.git.git_clone", side_effect=_fake_git_clone):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/compute_node/{cn_id}/create-project-from-git",
            json={"git_origin": _origin("https://github.com/octocat/Hello-World.git")},
        )

    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["status"] == "SUCCESS"
    project = payload["data"]["project"]
    assert project["fs_storage_mount_path"].endswith("/Hello-World")
    assert target.exists()
    assert (target / "README.md").read_text().startswith("cloned from ")


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_create_project_from_git_indexes_clone(bootstrapped_client, monkeypatch):
    """A successful clone must run a one-shot indexer scan of the cloned tree so
    the project lands fully indexed (skills/agents/assets discoverable), not just
    minted. We spy the sanctioned ``_index_additional_dir`` seam to assert the
    wiring without depending on indexer corpus timing."""
    import flow_sdk.builtin.agentic_process.agentic_process as agentic_process

    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    leaf = "Indexed-World"
    target = Path(AGENT_MOUNT_FOLDER) / leaf
    if target.exists():
        import shutil
        shutil.rmtree(target)

    indexed: list[str] = []

    async def _spy_index(path: str) -> None:
        indexed.append(path)

    # Patched at the module attribute — the action imports the symbol lazily
    # inside the function body, so it resolves the patched version at call time.
    monkeypatch.setattr(agentic_process, "_index_additional_dir", _spy_index)

    with patch("flow_sdk.utils.git.git_clone", side_effect=_fake_git_clone):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/compute_node/{cn_id}/create-project-from-git",
            json={"git_origin": _origin(f"https://github.com/octocat/{leaf}.git")},
        )

    assert r.status_code == 200, r.text
    project = r.json()["data"]["project"]
    assert project["fs_storage_mount_path"].endswith(f"/{leaf}")
    # The cloned tree was scanned exactly once, at its own path.
    assert indexed == [str(target)]


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_create_project_from_git_clones_with_user_token(bootstrapped_client, monkeypatch):
    """The clone must authenticate with the caller's stored GitHub token — see
    ``git_remote_access`` in flow_sdk/utils/git.py for why check and clone have
    to share a credential path."""
    import flow_sdk.app.actions.oauth_action as oauth_action

    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    leaf = "Private-World"
    target = Path(AGENT_MOUNT_FOLDER) / leaf
    if target.exists():
        import shutil
        shutil.rmtree(target)

    async def _fake_token():
        return "ghs_test_token"

    # Patched on the defining module — the action imports the helper lazily
    # inside the function body, so it resolves the patched version at call time.
    monkeypatch.setattr(oauth_action, "_get_github_token_for_current_user", _fake_token)

    with patch("flow_sdk.utils.git.git_clone", side_effect=_fake_git_clone):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/compute_node/{cn_id}/create-project-from-git",
            json={"git_origin": _origin(f"https://github.com/octocat/{leaf}.git")},
        )

    assert r.status_code == 200, r.text
    assert last_clone["token"] == "ghs_test_token"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_create_project_from_git_collision_suggests(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    leaf = "preexisting-repo"
    existing = Path(AGENT_MOUNT_FOLDER) / leaf
    existing.mkdir(parents=True, exist_ok=True)
    (existing / "marker").write_text("untouched")

    # No mock — must short-circuit before git_clone runs.
    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/create-project-from-git",
        json={"git_origin": _origin(f"https://example.com/repos/{leaf}.git")},
    )
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["status"] == "FAIL"
    assert body["data"]["attempted_name"] == leaf
    assert body["data"]["suggested_name"] == f"{leaf}-2"
    # Existing folder is intact.
    assert (existing / "marker").read_text() == "untouched"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_create_project_from_git_accepts_suggested(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    leaf = "twice-cloned"
    base = Path(AGENT_MOUNT_FOLDER) / leaf
    suggested = Path(AGENT_MOUNT_FOLDER) / f"{leaf}-2"
    base.mkdir(parents=True, exist_ok=True)
    # Clean up the suggestion-target from any prior leaked run so the test is
    # idempotent — without this, a prior pass leaves the folder behind and the
    # next run trips the collision check.
    if suggested.exists():
        import shutil
        shutil.rmtree(suggested)

    with patch("flow_sdk.utils.git.git_clone", side_effect=_fake_git_clone):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/compute_node/{cn_id}/create-project-from-git",
            json={
                "git_origin": _origin(f"https://example.com/repos/{leaf}.git"),
                "target_name": f"{leaf}-2",
            },
        )

    assert r.status_code == 200, r.text
    project = r.json()["data"]["project"]
    assert project["fs_storage_mount_path"].endswith(f"/{leaf}-2")


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_create_project_from_git_missing_url(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    r = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/create-project-from-git",
        json={},
    )
    assert r.status_code == 400, r.text
    assert r.json()["status"] == "FAIL"


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_create_project_from_git_clone_failure(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _cn_id(bootstrap.json())

    async def _failing_clone(*_a, **_kw):
        return False, "fatal: repository not found"

    leaf = "does-not-exist"
    # Make sure the slot is free so we reach the clone call.
    target = Path(AGENT_MOUNT_FOLDER) / leaf
    if target.exists():
        import shutil
        shutil.rmtree(target)

    with patch("flow_sdk.utils.git.git_clone", side_effect=_failing_clone):
        r = await bootstrapped_client.post(
            f"/api/v1/graph/compute_node/{cn_id}/create-project-from-git",
            json={"git_origin": _origin(f"https://example.com/repos/{leaf}.git")},
        )
    assert r.status_code == 400, r.text
    body = r.json()
    assert body["status"] == "FAIL"
    assert "repository not found" in body["message"]
