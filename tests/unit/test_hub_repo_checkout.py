"""A shared project's working checkout of its hub-hosted repo (``HubRepoCheckout``):
cloned once, only ever fast-forwarded — never reset, cleaned or deleted like the
asset cache (``HubRepoMirror``). Driven against a local bare repo; the hub's own
auth header is ``_git_env``'s job and rides the same ``git()``.
"""
from __future__ import annotations

import subprocess

import pytest

from flow_sdk.assets.git_publish import GitAuthor
from flow_sdk.assets.hub_repo_sync import HubRepoCheckout, HubRepoMirror, sync_project_with_hub
from flow_sdk.fs_store.origin.field import as_project_origin
from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True, capture_output=True)


@pytest.fixture
def upstream(tmp_path):
    bare, work = tmp_path / "hub.git", tmp_path / "author"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(bare))
    _git(tmp_path, "clone", "-q", str(bare), str(work))
    (work / "report.html").write_text("v1")
    _git(work, "add", "-A")
    _git(work, "commit", "-qm", "v1")
    _git(work, "push", "-q", "origin", "HEAD:main")
    return bare, work


async def test_clone_then_fast_forward_keeps_local_work(tmp_path, upstream):
    bare, author = upstream
    mine = HubRepoCheckout(root=tmp_path / "mine", clone_url=bare.as_uri(), branch="main", token="t")
    await mine.checkout()
    (tmp_path / "mine/notes.md").write_text("mine")
    (author / "report.html").write_text("v2")
    _git(author, "commit", "-qam", "v2")
    _git(author, "push", "-q", "origin", "HEAD:main")

    await mine.checkout()

    assert (tmp_path / "mine/report.html").read_text() == "v2"
    assert (tmp_path / "mine/notes.md").read_text() == "mine"


async def test_never_clones_over_a_folder_with_content(tmp_path, upstream):
    (tmp_path / "taken").mkdir()
    (tmp_path / "taken/keep.txt").write_text("x")
    with pytest.raises(RuntimeError, match="not empty"):
        await HubRepoCheckout(root=tmp_path / "taken", clone_url=upstream[0].as_uri(), branch="main", token="t").checkout()
    assert (tmp_path / "taken/keep.txt").read_text() == "x"


def test_a_project_can_be_checked_out_from_git_or_its_hub_copy_only():
    assert isinstance(as_project_origin({"kind": "hub_repo", "repo": "git_repo-1", "rel_path": "."}), HubRepoOrigin)
    assert as_project_origin({"kind": "git", "provider": "github", "owner": "o", "name": "n"}) is not None
    assert as_project_origin({"kind": "local", "base": "/x"}) is None


async def test_a_machine_without_git_is_told_so(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path / "empty-bin"))
    with pytest.raises(Exception, match="Git is not installed"):
        await HubRepoCheckout(root=tmp_path / "x", clone_url="http://h/r", branch="main", token="t").checkout()


async def test_a_project_folder_is_published_as_git_sees_it_and_again_after_the_hub_moved(tmp_path, upstream):
    """What travels is the folder's tracked and new files at their working content, never an
    ignored one — and a second publish lands on top of whatever reached the hub in between."""
    bare, author = upstream
    project = tmp_path / "project"
    project.mkdir()
    _git(project, "init", "-q", "-b", "main")
    (project / ".gitignore").write_text("secret.env\n")
    (project / "app.py").write_text("v1")
    (project / "secret.env").write_text("KEY=1")
    _git(project, "add", "-A")
    _git(project, "commit", "-qm", "first")
    (project / "new.md").write_text("not committed yet")
    mirror = HubRepoMirror(root=tmp_path / "mirror", clone_url=bare.as_uri(), branch="main", token="t")
    who = GitAuthor(name="t", email="t@t")

    first = await sync_project_with_hub(mirror=mirror, checkout=project, author=who, project_typeid="project-1")
    # The hub moves on: someone publishes an asset into the same repository.
    _git(author, "pull", "-q", "origin", "main")
    (author / "asset.md").write_text("an asset")
    _git(author, "add", "-A")
    _git(author, "commit", "-qm", "asset")
    _git(author, "push", "-q", "origin", "HEAD:main")
    (project / "app.py").write_text("v2")
    second = await sync_project_with_hub(mirror=mirror, checkout=project, author=who, project_typeid="project-1")
    again = await sync_project_with_hub(mirror=mirror, checkout=project, author=who, project_typeid="project-1")

    _git(author, "pull", "-q", "origin", "main")
    assert first != second == again
    assert (author / "app.py").read_text() == "v2"
    assert (author / "new.md").read_text() == "not committed yet"
    assert not (author / "secret.env").exists()
    # The project's own files replaced the repository's: what it does not hold is gone.
    assert not (author / "report.html").exists()
