"""GitBox — where git runs, and what is left behind when it is done.

GitBox adds exactly two things on top of :class:`GitFolder`: it decides which
node executes git, and it guarantees the scratch checkout does not outlive the
operation. So that is what this file pins, against a real ``@local`` node and a
real bare remote.

The properties worth holding:

* **The scratch path is absolute and per-origin.** A compute node ignores the
  per-node working directory and resolves relative paths against its own home,
  so a relative scratch would be created — and later deleted — somewhere the
  caller never named.
* **The box closes on the failure path too.** A clone that dies half-way leaves
  a partial checkout, and the next attempt must not adopt it.
* **What crosses back is bytes.** Nothing the caller receives is a path into the
  box, because after ``close()`` there is nothing there.
"""

from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path

import pytest

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.faas.git_box import GitBox
from flow_sdk.utils.git_folder import GitError, GitErrorCode
from tests.unit.conftest import git_cmd

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

ASSET_DIR = "docs"


@pytest.fixture
async def local_node() -> ComputeNode:
    return await ComputeNode.get_local()


def origin_for(git_remote, *, rel_path: str = ASSET_DIR, branch: str = "flow-cloud") -> PortableGitOrigin:
    """An origin whose clone_url is rewritten onto the local bare remote.

    ``PortableGitOrigin`` only models canonical GitHub coordinates, so the
    fixture's ``insteadOf`` rewrite is what lets a real publish/fetch cycle run
    without touching the network.
    """
    return PortableGitOrigin(
        provider="github",
        owner="flowpad",
        name="assets",
        branch=branch,
        head_commit="0" * 40,
        rel_path=rel_path,
    )


def seed_cloud_branch(git_remote, *, branch: str = "flow-cloud") -> str:
    repo = git_remote.make_checkout("publisher", github_url="https://github.com/flowpad/assets.git")
    (repo / ASSET_DIR).mkdir()
    (repo / ASSET_DIR / "note.md").write_text("shared\n", encoding="utf-8")
    git_cmd(repo, "add", ".")
    git_cmd(repo, "commit", "-q", "-m", "publish")
    git_cmd(repo, "push", "-q", "origin", f"HEAD:refs/heads/{branch}")
    return git_cmd(repo, "rev-parse", "HEAD")


def zip_names(payload: bytes) -> set[str]:
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        return {i.filename for i in archive.infolist() if not i.is_dir()}


# ── the scratch path ─────────────────────────────────────────────────────────


async def test_the_scratch_root_is_absolute(local_node, git_remote):
    """A node resolves a relative path against its own home, not ours."""
    root = GitBox._scratch_root(local_node, origin_for(git_remote))

    assert Path(root).is_absolute(), f"relative scratch root would land somewhere unnamed: {root}"


async def test_two_assets_from_one_repo_get_separate_scratch(local_node, git_remote):
    """They need different sparse sets; a shared checkout has them fighting over
    one sparse-checkout config."""
    docs = GitBox._scratch_root(local_node, origin_for(git_remote, rel_path="docs"))
    specs = GitBox._scratch_root(local_node, origin_for(git_remote, rel_path="specs"))

    assert docs != specs


async def test_the_same_asset_reuses_one_scratch(local_node, git_remote):
    """So a retry reuses the clone it already paid for."""
    origin = origin_for(git_remote)

    assert GitBox._scratch_root(local_node, origin) == GitBox._scratch_root(local_node, origin)


# ── lifecycle ────────────────────────────────────────────────────────────────


async def test_capture_returns_bytes_and_leaves_nothing_behind(local_node, git_remote, monkeypatch, tmp_path):
    _rewrite_github_to(monkeypatch, git_remote, tmp_path)
    seed_cloud_branch(git_remote)
    origin = origin_for(git_remote)

    async with GitBox.open(origin, node=local_node) as box:
        receipt = await box.capture(origin)
        root = box.root

    assert zip_names(receipt.archive) == {"note.md"}
    assert not Path(root).exists(), "the scratch checkout outlived the box"


async def test_the_box_closes_even_when_the_body_raises(local_node, git_remote, monkeypatch, tmp_path):
    """A failed clone leaves a partial checkout; the next attempt must not
    adopt it."""
    _rewrite_github_to(monkeypatch, git_remote, tmp_path)
    seed_cloud_branch(git_remote)
    origin = origin_for(git_remote)
    captured_root = None

    with pytest.raises(RuntimeError, match="boom"):
        async with GitBox.open(origin, node=local_node) as box:
            captured_root = box.root
            await box.capture(origin)
            raise RuntimeError("boom")

    assert captured_root and not Path(captured_root).exists()


async def test_close_is_survivable_when_the_scratch_never_existed(local_node, git_remote):
    """A box whose node died, or whose clone never started, must not turn
    successful work into an error on the way out."""
    origin = origin_for(git_remote)

    async with GitBox.open(origin, node=local_node) as box:
        assert not Path(box.root).exists()


async def test_capture_defaults_to_the_origins_own_rel_path(local_node, git_remote, monkeypatch, tmp_path):
    """Restating the subtree at the call site is how the two drift apart."""
    _rewrite_github_to(monkeypatch, git_remote, tmp_path)
    seed_cloud_branch(git_remote)
    origin = origin_for(git_remote, rel_path=ASSET_DIR)

    async with GitBox.open(origin, node=local_node) as box:
        assert zip_names((await box.capture(origin)).archive) == {"note.md"}


async def test_an_unprovisioned_branch_reports_branch_not_found(local_node, git_remote, monkeypatch, tmp_path):
    """Never a silent branch-and-push: provisioning belongs to the publisher."""
    _rewrite_github_to(monkeypatch, git_remote, tmp_path)
    git_remote.make_checkout("publisher", github_url="https://github.com/flowpad/assets.git")
    origin = origin_for(git_remote)

    async with GitBox.open(origin, node=local_node) as box:
        with pytest.raises(GitError) as excinfo:
            await box.capture(origin)
    assert excinfo.value.code is GitErrorCode.BRANCH_NOT_FOUND


# ── helpers ──────────────────────────────────────────────────────────────────


def _rewrite_github_to(monkeypatch, git_remote, tmp_path: Path) -> None:
    """Make the GitHub->local rewrite visible to a fresh clone anywhere.

    The fixture's ``insteadOf`` lives in the publisher checkout's LOCAL config,
    so a clone elsewhere would not see it and would really dial github.com.
    A throwaway ``GIT_CONFIG_GLOBAL`` puts it where every git invocation finds
    it, without touching the developer's real config.
    """
    config = tmp_path / "gitconfig"
    config.write_text(
        f'[url "{git_remote.uri}"]\n\tinsteadOf = https://github.com/flowpad/assets.git\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(config))
