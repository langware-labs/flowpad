"""API tests for the git-ops endpoint on ComputeNode.

These tests run real git commands against a temporary directory — no mocking.
"""
import subprocess
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _git(path: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True)


def _get_compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    """Create a minimal git repo with one commit in tmp_path."""
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@test.com")
    _git(tmp_path, "config", "user.name", "Test")
    (tmp_path / "readme.txt").write_text("hello")
    _git(tmp_path, "add", ".")
    _git(tmp_path, "commit", "-m", "init")
    return tmp_path


@pytest.fixture
def empty_git_repo(tmp_path: Path) -> Path:
    """Create a git repo with no commits."""
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.email", "test@test.com")
    _git(tmp_path, "config", "user.name", "Test")
    return tmp_path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_git_ops_is_init(bootstrapped_client, git_repo):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/is-init",
        params={"workdir": str(git_repo)},
    )
    assert r.status_code == 200
    payload = r.json()
    assert payload["status"] == "SUCCESS"
    assert payload["data"]["isInit"] is True  # camelCase from alias_generator


@pytest.mark.asyncio
async def test_git_ops_is_init_non_repo(bootstrapped_client, tmp_path):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/is-init",
        params={"workdir": str(tmp_path)},
    )
    assert r.status_code == 200
    assert r.json()["data"]["isInit"] is False


@pytest.mark.asyncio
async def test_git_ops_branch(bootstrapped_client, git_repo):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/branch",
        params={"workdir": str(git_repo)},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["branch"] is not None  # "main" or "master" depending on git config


@pytest.mark.asyncio
async def test_git_ops_status_clean(bootstrapped_client, git_repo):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/status",
        params={"workdir": str(git_repo)},
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["error"] is None
    assert data["files"] == []


@pytest.mark.asyncio
async def test_git_ops_status_dirty(bootstrapped_client, git_repo):
    (git_repo / "new.txt").write_text("dirty")
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/status",
        params={"workdir": str(git_repo)},
    )
    assert r.status_code == 200
    files = r.json()["data"]["files"]
    assert any(f["path"] == "new.txt" for f in files)


@pytest.mark.asyncio
async def test_git_ops_is_linked_worktree_false(bootstrapped_client, git_repo):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/is-linked-worktree",
        params={"workdir": str(git_repo)},
    )
    assert r.status_code == 200
    assert r.json()["data"]["isLinkedWorktree"] is False  # camelCase from alias_generator


@pytest.mark.asyncio
async def test_git_ops_has_commit_true(bootstrapped_client, git_repo):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/has-commit",
        params={"workdir": str(git_repo)},
    )
    assert r.status_code == 200
    assert r.json()["data"]["hasCommit"] is True  # camelCase from alias_generator


@pytest.mark.asyncio
async def test_git_ops_has_commit_false_empty_repo(bootstrapped_client, empty_git_repo):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/has-commit",
        params={"workdir": str(empty_git_repo)},
    )
    assert r.status_code == 200
    assert r.json()["data"]["hasCommit"] is False


@pytest.mark.asyncio
async def test_git_ops_has_commit_false_non_repo(bootstrapped_client, tmp_path):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/has-commit",
        params={"workdir": str(tmp_path)},
    )
    assert r.status_code == 200
    assert r.json()["data"]["hasCommit"] is False


@pytest.mark.asyncio
async def test_git_ops_missing_workdir(bootstrapped_client):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/status",
    )
    assert r.json()["status"] == "FAIL"


@pytest.mark.asyncio
async def test_git_ops_unknown_subpath(bootstrapped_client, git_repo):
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _get_compute_node_id(bootstrap.json())

    r = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/git-ops/bogus",
        params={"workdir": str(git_repo)},
    )
    assert r.json()["status"] == "FAIL"
