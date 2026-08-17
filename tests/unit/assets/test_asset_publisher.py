"""Pins asset publishing against real git — successor to test_asset_git_worktree.py.

Every property the retired ``AssetGitWorktree`` suite held is still held here,
now through ``publish_asset`` over ``GitFolder``:

* a publish commits ONLY the asset path, leaving the user's unrelated staged
  work in their index untouched,
* an unrelated local commit blocks publishing (BRANCH_AHEAD),
* a publish whose push failed can be retried without producing a second commit,
* deleting an asset is itself a path-scoped commit.

Plus the property that is new: publishing advances the **cloud branch**. The
user's own branch moves whenever they work; ``flow-cloud`` moves only when they
publish, which is what makes a published asset a stable thing to point at.

The remote is a local bare repo reached through an ``insteadOf`` rewrite, so the
GitHub-only origin rule is exercised for real without touching the network.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import SecretStr

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.asset_publisher import CLOUD_BRANCH, publish_asset
from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError, GitAuthor
from flow_sdk.fs_store.type_id import TypeId
from tests.unit.conftest import git_cmd

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

GITHUB_URL = "https://github.com/flowpad/assets.git"


@pytest.fixture
def asset_repo(git_remote):
    """A checkout with a GitHub-looking origin and one asset at docs/q.md."""
    repo = git_remote.make_checkout(github_url=GITHUB_URL)
    (repo / "docs").mkdir()
    (repo / "docs" / "q.md").write_text("one\n", encoding="utf-8")
    (repo / "other.txt").write_text("base\n", encoding="utf-8")
    git_cmd(repo, "add", ".")
    git_cmd(repo, "commit", "-q", "-m", "seed asset")
    git_cmd(repo, "push", "-q", "origin", "main")
    return repo


def _kwargs(repo: Path, *, asset: str = "docs/q.md") -> dict:
    return {
        "asset_root": repo / asset,
        "asset_typeid": TypeId(type="markdown", id=mint_uuid()),
        "token": SecretStr("not-a-real-token"),
        "author": GitAuthor(name="Q", email="q@example.com", typeid=f"user-{mint_uuid()}"),
    }


async def test_publish_commits_only_the_asset_path(asset_repo, git_remote):
    """The user has unrelated staged work; it must survive untouched."""
    (asset_repo / "other.txt").write_text("staged unrelated\n", encoding="utf-8")
    git_cmd(asset_repo, "add", "other.txt")
    (asset_repo / "docs" / "q.md").write_text("two\n", encoding="utf-8")

    receipt = await publish_asset(**_kwargs(asset_repo))

    assert receipt.changed is True
    assert receipt.origin.rel_path == "docs/q.md"
    assert receipt.origin.head_commit == git_cmd(asset_repo, "rev-parse", "HEAD")
    assert git_cmd(asset_repo, "show", "--name-only", "--format=", "HEAD").split() == ["docs/q.md"]
    assert git_cmd(asset_repo, "diff", "--cached", "--name-only") == "other.txt"


async def test_publish_advances_the_cloud_branch(asset_repo, git_remote):
    (asset_repo / "docs" / "q.md").write_text("two\n", encoding="utf-8")

    receipt = await publish_asset(**_kwargs(asset_repo))

    assert receipt.origin.branch == CLOUD_BRANCH
    assert receipt.branch == CLOUD_BRANCH
    assert git_cmd(git_remote.path, "rev-parse", f"refs/heads/{CLOUD_BRANCH}") == receipt.head_commit
    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/main") == receipt.head_commit


async def test_unpublished_work_on_main_does_not_move_the_cloud_branch(asset_repo, git_remote):
    """The stability property a shared link depends on."""
    (asset_repo / "docs" / "q.md").write_text("two\n", encoding="utf-8")
    receipt = await publish_asset(**_kwargs(asset_repo))
    published = receipt.head_commit

    (asset_repo / "unrelated.txt").write_text("later work\n", encoding="utf-8")
    git_cmd(asset_repo, "add", ".")
    git_cmd(asset_repo, "commit", "-q", "-m", "later work")
    git_cmd(asset_repo, "push", "-q", "origin", "main")

    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/main") != published
    assert git_cmd(git_remote.path, "rev-parse", f"refs/heads/{CLOUD_BRANCH}") == published


async def test_second_publish_advances_the_cloud_branch(asset_repo, git_remote):
    (asset_repo / "docs" / "q.md").write_text("two\n", encoding="utf-8")
    first = await publish_asset(**_kwargs(asset_repo))

    (asset_repo / "docs" / "q.md").write_text("three\n", encoding="utf-8")
    second = await publish_asset(**_kwargs(asset_repo))

    assert second.head_commit != first.head_commit
    assert git_cmd(git_remote.path, "rev-parse", f"refs/heads/{CLOUD_BRANCH}") == second.head_commit


async def test_noop_publish_creates_no_commit(asset_repo):
    before = git_cmd(asset_repo, "rev-parse", "HEAD")
    receipt = await publish_asset(**_kwargs(asset_repo))
    assert receipt.changed is False
    assert git_cmd(asset_repo, "rev-parse", "HEAD") == before


async def test_noop_publish_still_provisions_the_cloud_branch(asset_repo, git_remote):
    """flow-cloud may not exist yet even when the asset commit already does."""
    receipt = await publish_asset(**_kwargs(asset_repo))
    assert receipt.changed is False
    assert git_cmd(git_remote.path, "rev-parse", f"refs/heads/{CLOUD_BRANCH}") == receipt.head_commit


async def test_unrelated_local_commit_blocks_publishing(asset_repo):
    (asset_repo / "other.txt").write_text("local commit\n", encoding="utf-8")
    git_cmd(asset_repo, "add", "other.txt")
    git_cmd(asset_repo, "commit", "-q", "-m", "unrelated")

    with pytest.raises(AssetPublishError) as raised:
        await publish_asset(**_kwargs(asset_repo))
    assert raised.value.code is AssetPublishCode.BRANCH_AHEAD


async def test_failed_push_is_retried_without_a_second_commit(asset_repo, git_remote, tmp_path: Path):
    """Without the recognized-retry path, a publish that committed then failed to
    push would be permanently stuck behind the BRANCH_AHEAD guard."""
    (asset_repo / "docs" / "q.md").write_text("pending push\n", encoding="utf-8")
    kwargs = _kwargs(asset_repo)
    git_cmd(asset_repo, "remote", "set-url", "--push", "origin", (tmp_path / "unavailable.git").as_uri())

    with pytest.raises(AssetPublishError) as raised:
        await publish_asset(**kwargs)
    assert raised.value.code is AssetPublishCode.PUSH_REJECTED
    pending_head = git_cmd(asset_repo, "rev-parse", "HEAD")

    git_cmd(asset_repo, "remote", "set-url", "--push", "origin", git_remote.uri)
    receipt = await publish_asset(**kwargs)

    assert receipt.changed is True
    assert receipt.head_commit == pending_head
    assert git_cmd(asset_repo, "rev-list", "--count", "HEAD") == "3"
    assert git_cmd(git_remote.path, "rev-parse", "refs/heads/main") == pending_head


async def test_asset_deletion_is_committed_path_only(asset_repo):
    (asset_repo / "docs" / "q.md").unlink()
    receipt = await publish_asset(**_kwargs(asset_repo))
    assert receipt.changed is True
    assert git_cmd(asset_repo, "show", "--name-status", "--format=", "HEAD") == "D\tdocs/q.md"


async def test_a_non_github_origin_cannot_publish(git_remote):
    """Origin policy lives in the publisher, not in GitFolder."""
    repo = git_remote.make_checkout()  # plain file:// origin, no insteadOf rewrite
    (repo / "docs").mkdir()
    (repo / "docs" / "q.md").write_text("one\n", encoding="utf-8")

    with pytest.raises(AssetPublishError) as raised:
        await publish_asset(**_kwargs(repo))
    assert raised.value.code is AssetPublishCode.ORIGIN_INVALID


async def test_publishing_from_a_detached_head_is_refused(asset_repo):
    git_cmd(asset_repo, "checkout", "-q", "--detach", "HEAD")
    with pytest.raises(AssetPublishError) as raised:
        await publish_asset(**_kwargs(asset_repo))
    assert raised.value.code is AssetPublishCode.ORIGIN_INVALID


async def test_an_asset_outside_a_checkout_is_refused(tmp_path: Path):
    loose = tmp_path / "loose"
    loose.mkdir()
    (loose / "q.md").write_text("x", encoding="utf-8")

    with pytest.raises(AssetPublishError) as raised:
        await publish_asset(**_kwargs(loose, asset="q.md"))
    assert raised.value.code is AssetPublishCode.NOT_GIT_BACKED


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
