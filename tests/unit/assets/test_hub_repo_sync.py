"""The desktop half of hub-repo publishing: one asset moving between a project
folder (NOT a git repo) and its project's hub repository, through a mirror.

The hub remote is played by a local bare repository; the protocol, the mirror
and every decision are the real ones.
"""

import subprocess
from pathlib import Path

import pytest

from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError, GitAuthor
from flow_sdk.assets.hub_repo_sync import HubRepoMirror, local_tree, sync_asset_with_hub

AUTHOR = GitAuthor(name="Alice", email="alice@example.com", typeid="user-alice")
REL = "agentic-assets/skill/review"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture
def world(tmp_path: Path):
    hub = tmp_path / "hub.git"
    subprocess.run(["git", "init", "-q", "--bare", "--initial-branch=main", str(hub)], check=True)
    project = tmp_path / "project"
    asset = project / REL
    asset.mkdir(parents=True)
    (asset / "SKILL.md").write_text("v1\n")
    mirror = HubRepoMirror(root=tmp_path / "mirror", clone_url=str(hub), branch="main", token="hub-token")
    return hub, project, asset, mirror


async def _publish(mirror, asset, last_tree):
    return await sync_asset_with_hub(
        mirror=mirror,
        asset_root=asset,
        rel_path=REL,
        is_file=False,
        last_tree=last_tree,
        author=AUTHOR,
        asset_typeid="skill-1",
    )


def _hub_edit(tmp_path: Path, hub: Path, content: str) -> None:
    other = tmp_path / "other"
    if not other.exists():
        _git(tmp_path, "clone", "-q", str(hub), str(other))
    _git(other, "pull", "-q", "origin", "main")
    (other / REL / "SKILL.md").write_text(content)
    _git(other, "-c", "user.name=hub", "-c", "user.email=hub@x", "commit", "-qam", "hub edit")
    _git(other, "push", "-q", "origin", "HEAD:main")


async def test_first_publish_pushes_the_asset_at_its_project_path(world):
    hub, project, asset, mirror = world
    assert not (project / ".git").exists()

    first = await _publish(mirror, asset, None)

    assert first.pushed and not first.pulled_back
    assert _git(hub, "show", f"main:{REL}/SKILL.md") == "v1"
    assert "FlowPad-Asset: skill-1" in _git(hub, "log", "-1", "--format=%B", "main")


async def test_republishing_unchanged_content_pushes_nothing(world):
    hub, _, asset, mirror = world
    first = await _publish(mirror, asset, None)
    again = await _publish(mirror, asset, first.tree)
    assert not again.pushed and again.tree == first.tree
    assert _git(hub, "rev-list", "--count", "main") == "1"


async def test_a_local_change_is_pushed(world):
    hub, _, asset, mirror = world
    first = await _publish(mirror, asset, None)
    (asset / "SKILL.md").write_text("v2\n")
    second = await _publish(mirror, asset, first.tree)
    assert second.pushed and second.tree != first.tree
    assert _git(hub, "show", f"main:{REL}/SKILL.md") == "v2"


async def test_a_hub_edit_is_pulled_back_when_the_desk_did_not_change(world, tmp_path):
    hub, _, asset, mirror = world
    first = await _publish(mirror, asset, None)
    _hub_edit(tmp_path, hub, "edited on the hub\n")

    synced = await _publish(mirror, asset, first.tree)

    assert synced.pulled_back and not synced.pushed
    assert (asset / "SKILL.md").read_text() == "edited on the hub\n"


async def test_edits_on_both_sides_are_a_conflict_and_nothing_moves(world, tmp_path):
    hub, _, asset, mirror = world
    first = await _publish(mirror, asset, None)
    _hub_edit(tmp_path, hub, "hub version\n")
    (asset / "SKILL.md").write_text("desk version\n")
    head_before = _git(hub, "rev-parse", "main")

    with pytest.raises(AssetPublishError) as refused:
        await _publish(mirror, asset, first.tree)

    assert refused.value.code == AssetPublishCode.ASSET_CONFLICT
    assert _git(hub, "rev-parse", "main") == head_before
    assert (asset / "SKILL.md").read_text() == "desk version\n"


async def test_local_tree_matches_the_published_tree_until_the_folder_changes(world):
    _, project, asset, mirror = world
    first = await _publish(mirror, asset, None)
    assert local_tree(mirror.root, project, REL) == first.tree
    (asset / "SKILL.md").write_text("changed\n")
    assert local_tree(mirror.root, project, REL) != first.tree


def test_sync_state_survives_and_finds_the_asset_by_its_local_path(tmp_path, monkeypatch):
    """The desk's record of the last tree lives beside the mirror, not on the entity (a re-index wipes that)."""
    from flow_sdk.assets import hub_repo_sync
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin

    monkeypatch.setattr(hub_repo_sync, "mirror_root", lambda repo_id: tmp_path / "hub_git" / "mirrors" / repo_id)
    asset = tmp_path / "project" / REL
    asset.mkdir(parents=True)
    hub_repo_sync.remember_sync(
        "r1", repo="git_repo-r1", rel_path=REL, tree="t1", head_commit="h1", local_path=str(asset.resolve())
    )

    assert hub_repo_sync.last_synced_tree("r1", REL) == "t1"
    found = hub_repo_sync.hub_origin_for_path(asset)
    assert isinstance(found, HubRepoOrigin)
    assert (found.repo, found.rel_path, found.tree, found.head_commit) == ("git_repo-r1", REL, "t1", "h1")
    assert hub_repo_sync.hub_origin_for_path(tmp_path / "elsewhere") is None


def test_repo_id_keeps_the_whole_uuid():
    from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin

    origin = HubRepoOrigin(repo="git_repo-fbd81993-4fdc-4d8d-ba13-ae0795d13813", rel_path="x")
    assert origin.repo_id == "fbd81993-4fdc-4d8d-ba13-ae0795d13813"
