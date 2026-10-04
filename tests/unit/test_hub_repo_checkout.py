"""A shared project's working checkout of its hub-hosted repo (``HubRepoCheckout``):
cloned once, only ever fast-forwarded — never reset, cleaned or deleted like the
asset cache (``HubRepoMirror``). Driven against a local bare repo; the hub's own
auth header is ``_git_env``'s job and rides the same ``git()``.
"""
from __future__ import annotations

import subprocess

import pytest

from flow_sdk.assets.hub_repo_sync import HubRepoCheckout
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
    _git(work, "add", "-A"), _git(work, "commit", "-qm", "v1"), _git(work, "push", "-q", "origin", "HEAD:main")
    return bare, work


async def test_clone_then_fast_forward_keeps_local_work(tmp_path, upstream):
    bare, author = upstream
    mine = HubRepoCheckout(root=tmp_path / "mine", clone_url=bare.as_uri(), branch="main", token="t")
    await mine.checkout()
    (tmp_path / "mine/notes.md").write_text("mine")
    (author / "report.html").write_text("v2")
    _git(author, "commit", "-qam", "v2"), _git(author, "push", "-q", "origin", "HEAD:main")

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
