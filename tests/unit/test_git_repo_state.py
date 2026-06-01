"""Backend test for ``project/git-state`` against fixture project workdirs.

Builds five throwaway git repos covering the five states the
``GitRepoAcceptModal`` discriminates against, runs the action, and asserts
the response shape.

The matching TS reducer ``deriveRepoState`` is unit-tested in
``ui/tests/unit/derive-repo-state.test.ts`` — together the two suites cover
the contract from the subprocess all the way to the reducer's case output.
"""
from __future__ import annotations

import asyncio
import subprocess
import uuid
from pathlib import Path

import pytest

from flow_sdk.app.actions.project_git_state_action import project_git_state
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiSuccessResponse


def _run(args: list[str], cwd: str) -> None:
    """Run a git command; raise loudly if it fails so a misconfigured fixture
    surfaces as the test's failure, not a False from a downstream assertion."""
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True, timeout=10)


def _init_repo_with_remote(path: Path, remote_url: str, branch: str = "main") -> None:
    path.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--initial-branch", branch], str(path))
    _run(["git", "config", "user.email", "test@local.test"], str(path))
    _run(["git", "config", "user.name", "Test"], str(path))
    _run(["git", "remote", "add", "origin", remote_url], str(path))
    (path / "README.md").write_text(f"# {path.name}\n")
    _run(["git", "add", "-A"], str(path))
    _run(["git", "commit", "-q", "-m", "init"], str(path))


def _make_bare(path: Path) -> str:
    """Bare repo so we can fetch / track upstream without network."""
    path.mkdir(parents=True, exist_ok=True)
    _run(["git", "init", "-q", "--bare"], str(path))
    return str(path)


def _make_project(workdir: Path | None) -> Project:
    """Construct a Project bypassing the model validator.

    The validator auto-fills ``fs_storage_mount_path`` from ``name`` AND
    creates the folder on disk when it's missing — both behaviors interfere
    with our test fixtures that need explicit None / explicit missing paths.
    """
    return Project.model_construct(
        id=str(uuid.uuid4()),
        type="project",
        name="t",
        fs_storage_mount_path=str(workdir) if workdir is not None else None,
    )


async def _call(project: Project) -> dict:
    resp = await project_git_state(self=project)
    assert isinstance(resp, ApiSuccessResponse), resp
    assert isinstance(resp.data, dict)
    return resp.data


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_no_workdir(tmp_path):
    """Project without fs_storage_mount_path → workdir is None, workdir_exists False."""
    data = await _call(_make_project(None))
    assert data["workdir"] is None
    assert data["workdir_exists"] is False
    assert data["has_repo"] is False
    assert data["current_branch"] is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_workdir_set_but_missing(tmp_path):
    """fs_storage_mount_path points at a non-existent path → workdir_exists False."""
    missing = tmp_path / "does-not-exist"
    data = await _call(_make_project(missing))
    assert data["workdir"] == str(missing)
    assert data["workdir_exists"] is False
    assert data["has_repo"] is False


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_workdir_exists_but_no_git(tmp_path):
    """Empty existing folder (no .git) → has_repo=False (CLONE case)."""
    workdir = tmp_path / "empty"
    workdir.mkdir()
    data = await _call(_make_project(workdir))
    assert data["workdir_exists"] is True
    assert data["has_repo"] is False
    assert data["remote_full_name"] is None
    assert data["current_branch"] is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_clean_repo_same_branch(tmp_path):
    """Project's workdir has a .git pointing at origin, clean tree, on main."""
    bare = _make_bare(tmp_path / "origin.git")
    workdir = tmp_path / "proj"
    _init_repo_with_remote(workdir, f"file://{bare}", branch="main")
    _run(["git", "push", "-u", "origin", "main"], str(workdir))

    data = await _call(_make_project(workdir))
    assert data["has_repo"] is True
    assert data["current_branch"] == "main"
    assert data["has_uncommitted"] is False
    assert data["behind_remote"] is False
    assert data["head_commit"]
    # remote_full_name parsing from file:// URLs may not produce owner/repo
    # form — we don't assert its value here, only that the field exists.
    assert "remote_full_name" in data


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_dirty_repo(tmp_path):
    """Same repo, same branch, but with uncommitted changes → has_uncommitted=True."""
    bare = _make_bare(tmp_path / "origin.git")
    workdir = tmp_path / "proj"
    _init_repo_with_remote(workdir, f"file://{bare}", branch="main")
    _run(["git", "push", "-u", "origin", "main"], str(workdir))
    (workdir / "dirty.txt").write_text("hello\n")

    data = await _call(_make_project(workdir))
    assert data["has_repo"] is True
    assert data["has_uncommitted"] is True


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_different_branch(tmp_path):
    """Same repo, different branch checked out → current_branch reflects it."""
    bare = _make_bare(tmp_path / "origin.git")
    workdir = tmp_path / "proj"
    _init_repo_with_remote(workdir, f"file://{bare}", branch="main")
    _run(["git", "push", "-u", "origin", "main"], str(workdir))
    _run(["git", "checkout", "-q", "-b", "feature-x"], str(workdir))

    data = await _call(_make_project(workdir))
    assert data["has_repo"] is True
    assert data["current_branch"] == "feature-x"


@pytest.mark.asyncio
@pytest.mark.timeout(30)
async def test_behind_remote(tmp_path):
    """Local is behind remote → behind_remote=True."""
    bare = _make_bare(tmp_path / "origin.git")
    workdir_a = tmp_path / "proj-a"
    workdir_b = tmp_path / "proj-b"
    # A makes a commit and pushes; B clones, then A pushes another commit;
    # B is now one commit behind.
    _init_repo_with_remote(workdir_a, f"file://{bare}", branch="main")
    _run(["git", "push", "-u", "origin", "main"], str(workdir_a))
    _run(["git", "clone", "-q", f"file://{bare}", str(workdir_b)], cwd=str(tmp_path))
    _run(["git", "config", "user.email", "test@local.test"], str(workdir_b))
    _run(["git", "config", "user.name", "Test"], str(workdir_b))
    (workdir_a / "second.txt").write_text("second\n")
    _run(["git", "add", "-A"], str(workdir_a))
    _run(["git", "commit", "-q", "-m", "second"], str(workdir_a))
    _run(["git", "push", "origin", "main"], str(workdir_a))
    # B needs to fetch before the rev-list comparison sees the delta.
    _run(["git", "fetch", "origin"], str(workdir_b))

    data = await _call(_make_project(workdir_b))
    assert data["behind_remote"] is True
    assert data["ahead_of_remote"] is False
