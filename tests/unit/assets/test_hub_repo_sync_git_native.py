"""A project folder that IS a git checkout publishes its own history, never a copy.

The hub remote and the project's own remote ("GitHub") are local bare
repositories; the checkout, the mirror and every git decision are real.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError, GitAuthor
from flow_sdk.assets.hub_repo_sync import (
    HubRepoMirror,
    git_source_state,
    sync_asset_with_hub,
    sync_project_with_hub,
)

AUTHOR = GitAuthor(name="Alice", email="alice@example.com", typeid="user-alice")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=a", "-c", "user.email=a@x", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout.strip()


def _bare(path: Path) -> Path:
    subprocess.run(["git", "init", "-q", "--bare", "--initial-branch=main", str(path)], check=True)
    return path


@pytest.fixture
def world(tmp_path: Path):
    hub = _bare(tmp_path / "hub.git")
    project = tmp_path / "project"
    project.mkdir()
    _git(project, "init", "-q", "-b", "main")
    (project / "README.md").write_text("hello\n")
    (project / ".gitignore").write_text("node_modules/\n")
    _git(project, "add", "-A")
    _git(project, "commit", "-qm", "first")
    mirror = HubRepoMirror(root=tmp_path / "mirror", clone_url=str(hub), branch="main", token="hub-token")
    return hub, project, mirror


async def _publish(mirror, project):
    return await sync_project_with_hub(mirror=mirror, checkout=project, author=AUTHOR, project_typeid="project-1")


async def test_without_a_remote_the_hub_gets_the_persons_own_commits(world):
    hub, project, mirror = world

    head = await _publish(mirror, project)

    assert head == _git(project, "rev-parse", "HEAD")
    assert _git(hub, "rev-parse", "main") == head, "the hub branch IS the person's commit, not a snapshot of it"
    (project / "README.md").write_text("hello again\n")
    _git(project, "commit", "-qam", "second")
    assert await _publish(mirror, project) == _git(hub, "rev-parse", "main") == _git(project, "rev-parse", "HEAD")
    assert _git(hub, "log", "--format=%s", "main").splitlines() == ["second", "first"]


async def test_uncommitted_work_is_refused_with_what_to_do(world):
    hub, project, mirror = world
    (project / "README.md").write_text("edited\n")
    (project / "new.txt").write_text("new\n")
    (project / "node_modules").mkdir()
    (project / "node_modules" / "x.js").write_text("ignored\n")
    (project / ".env").write_text("SECRET=1\n")

    with pytest.raises(AssetPublishError) as raised:
        await _publish(mirror, project)

    assert raised.value.code is AssetPublishCode.NOT_COMMITTED
    # Ignored files and secrets never travel, so they never block either.
    assert str(raised.value) == "2 changes not committed — commit, then deploy"
    assert sorted(raised.value.data["uncommitted"]) == ["README.md", "new.txt"]
    assert _git(hub, "branch", "--list") == "", "nothing reached the hub"


async def test_with_a_remote_only_a_pushed_commit_deploys(world, tmp_path):
    hub, project, mirror = world
    github = _bare(tmp_path / "github.git")
    _git(project, "remote", "add", "origin", str(github))
    (project / "README.md").write_text("two\n")
    _git(project, "commit", "-qam", "second")

    with pytest.raises(AssetPublishError) as raised:
        await _publish(mirror, project)
    assert raised.value.code is AssetPublishCode.NOT_PUSHED
    assert str(raised.value) == "2 commits not pushed — push, then deploy"

    _git(project, "push", "-q", "origin", "main")
    head = await _publish(mirror, project)
    assert head == _git(github, "rev-parse", "main") == _git(hub, "rev-parse", "main")

    (project / "README.md").write_text("dirty\n")
    with pytest.raises(AssetPublishError) as raised:
        await _publish(mirror, project)
    assert str(raised.value) == "1 change not committed — commit and push, then deploy"


async def test_old_snapshot_commits_are_replaced_but_a_hub_edit_is_not(world, tmp_path):
    hub, project, mirror = world
    other = tmp_path / "other"
    _git(tmp_path, "clone", "-q", str(hub), str(other))
    (other / "snap.txt").write_text("snapshot\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-qm", "Publish FlowPad project p\n\nFlowPad-Project: project-1")
    _git(other, "push", "-q", "origin", "HEAD:main")

    head = await _publish(mirror, project)
    assert _git(hub, "rev-parse", "main") == head == _git(project, "rev-parse", "HEAD")

    _git(other, "fetch", "-q", "origin")
    _git(other, "reset", "-q", "--hard", "origin/main")
    (other / "hub.txt").write_text("edited on the hub\n")
    _git(other, "add", "-A")
    _git(other, "commit", "-qm", "edited on the hub")
    _git(other, "push", "-q", "origin", "HEAD:main")
    (project / "README.md").write_text("diverged\n")
    _git(project, "commit", "-qam", "diverged")

    with pytest.raises(AssetPublishError) as raised:
        await _publish(mirror, project)
    assert raised.value.code is AssetPublishCode.ASSET_CONFLICT
    assert _git(hub, "log", "-1", "--format=%s", "main") == "edited on the hub"


async def test_after_the_history_push_an_unchanged_asset_pushes_nothing(world):
    hub, project, mirror = world
    agent = project / "agentic-assets" / "agent" / "q"
    agent.mkdir(parents=True)
    (agent / "agent.json").write_text("{}\n")
    _git(project, "add", "-A")
    _git(project, "commit", "-qm", "agent")
    head = await _publish(mirror, project)

    synced = await sync_asset_with_hub(
        mirror=mirror,
        asset_root=agent,
        rel_path="agentic-assets/agent/q",
        is_file=False,
        last_tree=None,
        author=AUTHOR,
        asset_typeid="agent-1",
    )

    assert synced.pushed is False
    assert _git(hub, "rev-parse", "main") == head, "the deploy runs the person's commit"


async def test_a_folder_that_is_not_a_checkout_keeps_its_ignored_trees_home(tmp_path):
    """A4: an agent webapp's ``node_modules`` in a plain project folder was copied file by file into
    the mirror (``ignored_under`` answers nothing outside a work tree) — minutes on a real one."""
    _bare(tmp_path / "hub.git")
    project = tmp_path / "project"
    agent = project / "agentic-assets" / "agent" / "q"
    (agent / "webapp" / "node_modules" / "pkg").mkdir(parents=True)
    (agent / "webapp" / "node_modules" / "pkg" / "index.js").write_text("x\n")
    (agent / "agent.json").write_text("{}\n")
    (project / ".gitignore").write_text("node_modules/\n")
    mirror = HubRepoMirror(root=tmp_path / "mirror", clone_url=str(tmp_path / "hub.git"), branch="main", token="t")
    assert git_source_state(project) is None

    await sync_asset_with_hub(
        mirror=mirror,
        asset_root=agent,
        rel_path="agentic-assets/agent/q",
        is_file=False,
        last_tree=None,
        author=AUTHOR,
        asset_typeid="agent-1",
    )

    assert (mirror.root / "agentic-assets/agent/q/agent.json").exists()
    assert not (mirror.root / "agentic-assets/agent/q/webapp/node_modules").exists()


async def test_a_hub_repo_wiped_under_a_used_mirror_takes_the_history_again(world):
    """A release replaced the hub's disk: the repo is re-created empty while this mirror still
    holds the old branch. The mirror must start unborn, not lease against a commit the hub lost."""
    hub, project, mirror = world
    await _publish(mirror, project)
    shutil.rmtree(hub)
    _bare(hub)
    (project / "README.md").write_text("after the wipe\n")
    _git(project, "commit", "-qam", "second")

    assert await _publish(mirror, project) == _git(hub, "rev-parse", "main") == _git(project, "rev-parse", "HEAD")
