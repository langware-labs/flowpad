"""``docs/snippets/project-git-share.md``, run as written.

Each fence runs against a real Project whose folder is a git checkout with a
GitHub origin (``acme/api``). The hub's answers are played by ``HubDouble``, which
also checks every request: the verb, the action and the body the SDK sent. §3
clones for real, from a local bare repo standing in for the hub's git endpoint.
"""

from __future__ import annotations

import subprocess
import uuid
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.schema.data_spec.git_share_spec import GitShareError, GitShareStatus
from tests.utils.git_share_hub_double import HubDouble
from tests.utils.snippets import doc, documented_raise, fence_under, run_fence

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

DOC = "project-git-share.md"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


async def _project(root: Path, *, remote: bool = True, origin: str = "https://github.com/acme/api.git") -> Project:
    root.mkdir(parents=True)
    _git(root, "init", "-q", "-b", "main")
    _git(root, "remote", "add", "origin", origin)
    project = Project(name=f"api-{uuid.uuid4().hex[:6]}", fs_storage_mount_path=str(root.resolve()))
    project.remote = remote
    await project.save()
    return project


@pytest.fixture
async def project(tmp_path, monkeypatch) -> Project:
    project = await _project(tmp_path / "api")
    monkeypatch.chdir(project.fs_storage_mount_path)
    return project


def _fence(heading: str, nth: int = 0) -> str:
    return fence_under(doc(DOC), heading, nth=nth)


async def _run(heading: str, ns: dict, nth: int = 0) -> dict:
    src = _fence(heading, nth)
    return await run_fence(src, ns, filename=f"{DOC} §{heading}{nth}", raises=documented_raise(src))


async def test_1_share_a_private_repo(project, monkeypatch):
    hub = HubDouble(str(project.id)).install(monkeypatch)
    ns = await _run("1.", {})

    share = ns["share"]
    assert ns["project"].id == project.id, "the fence finds the project from its own folder"
    assert (share.status, share.repo, share.clone_url) == (GitShareStatus.SHARED, "acme/api", hub.clone_url)
    assert hub.git_origin == {**hub.git_origin, "kind": "hub_repo", "repo": hub.git_repo}, (
        "once shared, members who accept the project clone it through the hub"
    )
    # Idempotent: asking again answers the same share.
    again = await ns["project"].share_git()
    assert (again.status, again.clone_url) == (GitShareStatus.SHARED, hub.clone_url)


@pytest.mark.parametrize("answer", ["install_required", "github_connect_required"])
async def test_2_when_github_needs_a_step_first(project, monkeypatch, capsys, answer):
    hub = HubDouble(str(project.id), answer=answer).install(monkeypatch)
    ns = await _run("2.", {"project": project})

    assert ns["share"].status == answer
    out = capsys.readouterr().out
    if answer == "install_required":
        assert "https://github.com/apps/flowpad/installations/new" in out and "acme/api" in out
    else:
        assert "Connect GitHub" in out
    assert hub.git_origin is None, "nothing changes on the hub until the share succeeds"


async def test_3_a_member_clones_through_the_hub(project, tmp_path, monkeypatch):
    # The hub's git endpoint, stood in by a bare repo with one commit on main.
    work, bare = tmp_path / "upstream", tmp_path / "hub.git"
    work.mkdir()
    _git(work, "init", "-q", "-b", "main")
    (work / "README.md").write_text("api\n")
    _git(work, "add", ".")
    _git(work, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init")
    _git(tmp_path, "clone", "-q", "--bare", str(work), str(bare))

    hub = HubDouble(str(project.id), clone_url=str(bare)).install(monkeypatch)
    hub.shared = True
    home = tmp_path / "member-home"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.resolve_hub_api_key", lambda **_k: "member-hub-key")

    ns = await _run("3.", {"project": project})

    checkout = home / "code" / "api"
    assert (checkout / "README.md").read_text() == "api\n", "the member got the repo"
    assert ns["checkout"].token == "member-hub-key", "with their own hub login"
    await ns["checkout"].checkout()  # a second call fast-forwards; it never re-clones or resets
    assert (checkout / "README.md").exists()


async def test_4_stop_sharing(project, monkeypatch, capsys):
    hub = HubDouble(str(project.id)).install(monkeypatch)
    await project.share_git()
    ns = await _run("4.", {"project": project})

    assert ns["share"].status == GitShareStatus.NOT_SHARED
    assert capsys.readouterr().out.strip().endswith("not_shared")
    assert ("DELETE",) in hub.calls
    assert hub.git_origin["owner"] == "acme" and hub.git_origin["name"] == "api", (
        "members who accept the project from now on are pointed at GitHub again"
    )


async def test_5_a_public_repo_needs_no_share(project, monkeypatch):
    HubDouble(str(project.id), answer="not_private").install(monkeypatch)
    ns = await _run("5.", {"project": project})
    assert ns["share"].status == GitShareStatus.NOT_PRIVATE


async def test_5_a_project_not_linked_to_the_cloud_is_refused(tmp_path, monkeypatch):
    local = await _project(tmp_path / "local", remote=False)
    monkeypatch.chdir(local.fs_storage_mount_path)
    hub = HubDouble(str(local.id)).install(monkeypatch)

    ns = await _run("5.", {"Project": Project, "os": __import__("os")}, nth=1)

    assert ns["local"].id == local.id
    assert hub.calls == [], "refused before anything reaches the hub"


async def test_a_folder_without_a_github_origin_is_refused(tmp_path, monkeypatch):
    other = await _project(tmp_path / "gitlab", origin="https://gitlab.com/acme/api.git")
    HubDouble(str(other.id)).install(monkeypatch)
    with pytest.raises(GitShareError, match="no GitHub origin"):
        await other.share_git()


async def test_status_of_an_unlinked_project_asks_the_hub_nothing(tmp_path, monkeypatch):
    local = await _project(tmp_path / "unlinked", remote=False)
    hub = HubDouble(str(local.id)).install(monkeypatch)
    assert (await local.git_share()).status == GitShareStatus.NOT_SHARED
    assert hub.calls == []
