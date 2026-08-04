from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from pydantic import SecretStr

from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError, GitAuthor
from flow_sdk.assets.git_worktree import AssetGitWorktree
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.type_id import TypeId


def _git(path: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=path, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def _repo(tmp_path: Path) -> tuple[Path, Path]:
    remote = tmp_path / "remote.git"
    repo = tmp_path / "repo"
    remote.mkdir()
    repo.mkdir()
    _git(remote, "init", "--bare", "-q")
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.name", "Test")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", f"url.{remote.as_uri()}.insteadOf", "https://github.com/flowpad/assets.git")
    _git(repo, "remote", "add", "origin", "https://github.com/flowpad/assets.git")
    (repo / "docs").mkdir()
    (repo / "docs" / "q.md").write_text("one\n", encoding="utf-8")
    (repo / "other.txt").write_text("base\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "initial")
    _git(repo, "push", "-q", "-u", "origin", "main")
    return repo, remote


@pytest.mark.asyncio
async def test_path_only_publish_preserves_unrelated_staged_work(tmp_path: Path) -> None:
    repo, remote = _repo(tmp_path)
    (repo / "other.txt").write_text("staged unrelated\n", encoding="utf-8")
    _git(repo, "add", "other.txt")
    (repo / "docs" / "q.md").write_text("two\n", encoding="utf-8")
    asset_typeid = TypeId(type="markdown", id=mint_uuid())
    actor = f"user-{mint_uuid()}"

    receipt = await AssetGitWorktree.resolve(repo / "docs" / "q.md").publish(
        asset_root=repo / "docs" / "q.md",
        asset_typeid=asset_typeid,
        token=SecretStr("not-a-real-token"),
        author=GitAuthor(name="Q", email="q@example.com", typeid=actor),
    )

    assert receipt.changed is True
    assert receipt.origin.rel_path == "docs/q.md"
    assert receipt.origin.head_commit == _git(repo, "rev-parse", "HEAD")
    assert _git(repo, "diff", "--cached", "--name-only") == "other.txt"
    message = _git(repo, "show", "-s", "--format=%B", "HEAD")
    assert f"FlowPad-Asset: {asset_typeid}" in message
    assert f"FlowPad-User: {actor}" in message
    assert _git(remote, "rev-parse", "refs/heads/main") == receipt.head_commit


@pytest.mark.asyncio
async def test_noop_creates_no_commit_and_unrelated_ahead_is_rejected(tmp_path: Path) -> None:
    repo, _ = _repo(tmp_path)
    asset_typeid = TypeId(type="markdown", id=mint_uuid())
    kwargs = {
        "asset_root": repo / "docs" / "q.md",
        "asset_typeid": asset_typeid,
        "token": SecretStr("not-a-real-token"),
        "author": GitAuthor(name="Q", email="q@example.com", typeid=f"user-{mint_uuid()}"),
    }
    before = _git(repo, "rev-parse", "HEAD")
    receipt = await AssetGitWorktree.resolve(kwargs["asset_root"]).publish(**kwargs)
    assert receipt.changed is False
    assert _git(repo, "rev-parse", "HEAD") == before

    (repo / "other.txt").write_text("local commit\n", encoding="utf-8")
    _git(repo, "add", "other.txt")
    _git(repo, "commit", "-q", "-m", "unrelated")
    with pytest.raises(AssetPublishError) as raised:
        await AssetGitWorktree.resolve(kwargs["asset_root"]).publish(**kwargs)
    assert raised.value.code is AssetPublishCode.BRANCH_AHEAD


@pytest.mark.asyncio
async def test_failed_same_asset_push_is_retried_without_a_second_commit(tmp_path: Path) -> None:
    repo, remote = _repo(tmp_path)
    asset = repo / "docs" / "q.md"
    asset.write_text("pending push\n", encoding="utf-8")
    asset_typeid = TypeId(type="markdown", id=mint_uuid())
    kwargs = {
        "asset_root": asset,
        "asset_typeid": asset_typeid,
        "token": SecretStr("not-a-real-token"),
        "author": GitAuthor(name="Q", email="q@example.com", typeid=f"user-{mint_uuid()}"),
    }
    unavailable = tmp_path / "unavailable.git"
    _git(repo, "remote", "set-url", "--push", "origin", unavailable.as_uri())

    with pytest.raises(AssetPublishError) as raised:
        await AssetGitWorktree.resolve(asset).publish(**kwargs)
    assert raised.value.code is AssetPublishCode.PUSH_REJECTED
    pending_head = _git(repo, "rev-parse", "HEAD")

    _git(repo, "remote", "set-url", "--push", "origin", remote.as_uri())
    receipt = await AssetGitWorktree.resolve(asset).publish(**kwargs)
    assert receipt.changed is True
    assert receipt.head_commit == pending_head
    assert _git(repo, "rev-list", "--count", "HEAD") == "2"
    assert _git(remote, "rev-parse", "refs/heads/main") == pending_head


@pytest.mark.asyncio
async def test_asset_deletion_is_committed_path_only(tmp_path: Path) -> None:
    repo, _ = _repo(tmp_path)
    asset = repo / "docs" / "q.md"
    asset.unlink()
    receipt = await AssetGitWorktree.resolve(asset).publish(
        asset_root=asset,
        asset_typeid=TypeId(type="markdown", id=mint_uuid()),
        token=SecretStr("not-a-real-token"),
        author=GitAuthor(name="Q", email="q@example.com", typeid=f"user-{mint_uuid()}"),
    )
    assert receipt.changed is True
    assert _git(repo, "show", "--name-status", "--format=", "HEAD") == "D\tdocs/q.md"
