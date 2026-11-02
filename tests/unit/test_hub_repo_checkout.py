"""A shared project's working checkout of its hub-hosted repo (``HubRepoCheckout``):
cloned once, only ever fast-forwarded — never reset, cleaned or deleted like the
asset cache (``HubRepoMirror``). Driven against a local bare repo; the hub's own
auth header is ``_git_env``'s job and rides the same ``git()``.
"""
from __future__ import annotations

import subprocess

import pytest

from flow_sdk.assets.git_publish import AssetPublishError, GitAuthor
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


def _out(cwd, *args) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


async def test_a_git_project_is_published_as_its_own_commits_and_again_after_the_hub_moved(tmp_path):
    """A checkout publishes its HEAD — never an ignored file, never uncommitted work — and a second
    publish replaces the snapshot commit an asset publish left on the hub in between."""
    bare, author = tmp_path / "hub.git", tmp_path / "author"
    _git(tmp_path, "init", "-q", "--bare", "-b", "main", str(bare))
    project = tmp_path / "project"
    project.mkdir()
    _git(project, "init", "-q", "-b", "main")
    (project / ".gitignore").write_text("secret.env\n")
    (project / "app.py").write_text("v1")
    (project / "secret.env").write_text("KEY=1")
    _git(project, "add", "-A")
    _git(project, "commit", "-qm", "first")
    mirror = HubRepoMirror(root=tmp_path / "mirror", clone_url=bare.as_uri(), branch="main", token="t")
    who = GitAuthor(name="t", email="t@t")

    first = await sync_project_with_hub(mirror=mirror, checkout=project, author=who, project_typeid="project-1")
    # The hub moves on: an asset publish lands a snapshot commit on the repository.
    _git(tmp_path, "clone", "-q", str(bare), str(author))
    (author / "asset.md").write_text("an asset")
    _git(author, "add", "-A")
    _git(author, "commit", "-qm", "Publish FlowPad asset a\n\nFlowPad-Asset: skill-1")
    _git(author, "push", "-q", "origin", "HEAD:main")
    (project / "app.py").write_text("v2")
    with pytest.raises(AssetPublishError, match="1 change not committed"):
        await sync_project_with_hub(mirror=mirror, checkout=project, author=who, project_typeid="project-1")
    _git(project, "commit", "-qam", "v2")
    second = await sync_project_with_hub(mirror=mirror, checkout=project, author=who, project_typeid="project-1")
    again = await sync_project_with_hub(mirror=mirror, checkout=project, author=who, project_typeid="project-1")

    _git(author, "fetch", "-q", "origin")
    _git(author, "reset", "-q", "--hard", "origin/main")
    assert first == _out(project, "rev-parse", "HEAD~1")
    assert second == again == _out(project, "rev-parse", "HEAD") == _out(author, "rev-parse", "HEAD")
    assert (author / "app.py").read_text() == "v2"
    assert not (author / "secret.env").exists()
    assert not (author / "asset.md").exists()


async def test_non_git_project_publish_carries_agent_context_not_secrets(tmp_path, upstream):
    project = tmp_path / "plain"
    included = ["flow.json", ".agents/skills/check/SKILL.md", "docs/policy.md", "agentic-assets/mcp/tool/mcp.json", "agentic-assets/data_source/wa/data_source.json"]
    excluded = [".env.local", ".flow/runtime.json", "node_modules/pkg/file", "private.txt", "nested/hidden.txt"]
    for rel in [*included, *excluded, ".gitignore", "nested/.gitignore"]:
        path = project / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("private.txt\n" if rel == ".gitignore" else "hidden.txt\n" if rel == "nested/.gitignore" else "fixture")
    (project / "env-link").symlink_to(".env.local")
    mirror = HubRepoMirror(root=tmp_path / "mirror", clone_url=upstream[0].as_uri(), branch="main", token="t")
    await sync_project_with_hub(mirror=mirror, checkout=project, author=GitAuthor(name="t", email="t@t"), project_typeid="project-1")
    assert all((mirror.root / rel).is_file() for rel in included)
    assert all(not (mirror.root / rel).exists() for rel in excluded)
    assert not (project / ".git").exists()
    assert (mirror.root / "env-link").is_symlink()
    assert not (mirror.root / "env-link").exists(), "publishing must not dereference a secret symlink"


async def test_project_publish_preserves_declared_mcp_identity(tmp_path, upstream):
    import json

    from flow_sdk.schema.data_spec.io.identity import FolderCapsule, ensure_id

    project = tmp_path / "portable"
    server = project / "agentic-assets/mcp/calculator"
    agent = project / "agentic-assets/agent/travel"
    server.mkdir(parents=True)
    agent.mkdir(parents=True)
    server_id = ensure_id(server)
    (server / "mcp.json").write_text(json.dumps({"name": "calculator", "command": "fastmcp", "args": ["run"], "entrypoint": "server.py"}))
    (server / "server.py").write_text("# shared server\n")
    (agent / "agent.json").write_text(json.dumps({"name": "travel", "mcp_servers": [f"mcp-{server_id}"]}))
    excluded = [".flow/runtime.json", "agentic-assets/mcp/calculator/.flow/capsules/runtime.json",
                ".flow/runtime/.flow/capsules/identity.json"]
    for rel in excluded:
        path = project / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("private runtime")
    mirror = HubRepoMirror(root=tmp_path / "mirror", clone_url=upstream[0].as_uri(), branch="main", token="t")
    await sync_project_with_hub(mirror=mirror, checkout=project, author=GitAuthor(name="t", email="t@t"), project_typeid="project-1")
    received = tmp_path / "received"
    _git(tmp_path, "clone", "-q", upstream[0].as_uri(), str(received))
    received_id = FolderCapsule().read(received / server.relative_to(project))
    declaration = json.loads((received / agent.relative_to(project) / "agent.json").read_text())["mcp_servers"]
    assert received_id == server_id, "publishing must preserve the ID the agent's authored reference names"
    assert declaration == [f"mcp-{received_id}"]
    assert all(not (received / rel).exists() for rel in excluded)
