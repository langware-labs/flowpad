"""Sender-side matrix: can this asset travel by git, and the one-click fixes.

Contract:
  * only the SHARED path has to be committed — unrelated edits never block
    and are never swept into a commit;
  * the pinned commit has to be on the remote;
  * ``commit`` commits + pushes just the shared path, ``push`` pushes without
    staging anything; neither force-pushes; a remote that moved on is rebased
    onto; a real conflict comes back typed, with its paths.
"""

from __future__ import annotations

import subprocess

import pytest

from flow_sdk.app.actions.git_share_preflight_action import git_share_fix, git_share_preflight
from tests.unit.git_share._world import BRANCH, git

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FAMILIES = ["skill", "markdown", "chart"]


async def _preflight(w):
    async with w.phase("preflight"):
        return await git_share_preflight(w.family.type, w.asset_id)


async def _fix(w, fix):
    async with w.phase("fix"):
        return await git_share_fix(w.family.type, w.asset_id, fix)


@pytest.fixture
def sender(make_world):
    async def _make(family):
        w = make_world(family)
        await w.family.row(w.asset_id, w.sender).save(notify=False)
        return w

    return _make


def _dirty(w) -> set[str]:
    return {ln[3:] for ln in git(w.sender, "status", "--porcelain", "-uall").splitlines()}


def _remote_has(w, commit: str) -> bool:
    return bool(git(w.sender, "branch", "-r", "--contains", commit, check=False))


@pytest.mark.parametrize("family", FAMILIES)
async def test_a1_committed_and_pushed_is_available(sender, family):
    w = await sender(family)
    r = await _preflight(w)
    assert r["available"], r
    assert r["git_origin"]["head_commit"] == w.sender_commit()


@pytest.mark.parametrize("family", FAMILIES)
async def test_a2_modified_asset_offers_commit_which_commits_only_it(sender, family):
    w = await sender(family)
    w.write_asset("edited-token")
    (w.sender / "unrelated.txt").write_text("my other work\n", encoding="utf-8")
    r = await _preflight(w)
    assert (r["available"], r["code"], r["fix"]) == (False, "dirty", "commit"), r

    fixed = await _fix(w, "commit")
    assert fixed["ok"], fixed
    assert fixed["preflight"]["available"], fixed
    assert _dirty(w) == {"unrelated.txt"}, "the fix swept in or lost the person's other work"
    assert _remote_has(w, w.sender_commit())
    assert "edited-token" in git(w.sender, "show", f"HEAD:{w.family.main_file(w.sender).relative_to(w.sender)}")


@pytest.mark.parametrize("family", FAMILIES)
async def test_a3_untracked_new_file_in_asset_offers_commit(sender, family):
    w = await sender(family)
    target = w.family.main_file(w.sender)
    extra = (target.parent if w.family.main else target.parent) / "notes-extra.md"
    extra.write_text("new\n", encoding="utf-8")
    r = await _preflight(w)
    if w.family.main:  # a folder asset: the new file is part of it
        assert (r["code"], r["fix"]) == ("dirty", "commit"), r
        assert (await _fix(w, "commit"))["preflight"]["available"]
    else:  # a single-file asset: a sibling file is not part of it
        assert r["available"], r


@pytest.mark.parametrize("family", FAMILIES)
async def test_a4_unrelated_dirty_files_do_not_block(sender, family):
    w = await sender(family)
    (w.sender / "README.md").write_text("edited readme\n", encoding="utf-8")
    (w.sender / "scratch.txt").write_text("untracked\n", encoding="utf-8")
    r = await _preflight(w)
    assert r["available"], r


@pytest.mark.parametrize("family", FAMILIES)
async def test_a5_committed_not_pushed_offers_push_which_stages_nothing(sender, family):
    w = await sender(family)
    w.write_asset("local-only-token")
    git(w.sender, "commit", "-qam", "local")
    (w.sender / "scratch.txt").write_text("untracked\n", encoding="utf-8")
    r = await _preflight(w)
    assert (r["code"], r["fix"]) == ("unpushed", "push"), r

    fixed = await _fix(w, "push")
    assert fixed["ok"], fixed
    assert fixed["preflight"]["available"], fixed
    assert _dirty(w) == {"scratch.txt"}
    assert _remote_has(w, w.sender_commit())


@pytest.mark.parametrize("family", FAMILIES)
async def test_a6_branch_never_published_is_pushed_with_upstream(sender, family):
    w = await sender(family)
    git(w.sender, "checkout", "-q", "-b", "feature/new-local")
    w.write_asset("new-branch-token")
    git(w.sender, "commit", "-qam", "on new branch")
    r = await _preflight(w)
    assert r["code"] == "unpushed", r
    fixed = await _fix(w, "push")
    assert fixed["ok"] and fixed["preflight"]["available"], fixed
    assert git(w.sender, "rev-parse", "--abbrev-ref", "@{u}") == "origin/feature/new-local"


@pytest.mark.parametrize("family", FAMILIES)
async def test_a7_remote_moved_on_is_rebased_not_forced(sender, family):
    w = await sender(family)
    other = w.root / "colleague"
    git(w.root, "clone", "-q", "--branch", BRANCH, w.remote.as_uri(), str(other))
    git(other, "config", "user.email", "c@t.co")
    git(other, "config", "user.name", "colleague")
    (other / "theirs.txt").write_text("colleague's work\n", encoding="utf-8")
    git(other, "add", "-A")
    git(other, "commit", "-qm", "theirs")
    git(other, "push", "-q", "origin", BRANCH)
    theirs = git(other, "rev-parse", "HEAD")

    w.write_asset("mine-token")
    git(w.sender, "commit", "-qam", "mine")
    fixed = await _fix(w, "push")
    assert fixed["ok"], fixed
    assert fixed["preflight"]["available"], fixed
    kept = subprocess.run(["git", "merge-base", "--is-ancestor", theirs, "HEAD"], cwd=w.sender)
    assert kept.returncode == 0, "the colleague's commit was dropped (forced push?)"


@pytest.mark.parametrize("family", FAMILIES)
async def test_a7_conflict_comes_back_typed(sender, family):
    w = await sender(family)
    other = w.root / "colleague"
    git(w.root, "clone", "-q", "--branch", BRANCH, w.remote.as_uri(), str(other))
    git(other, "config", "user.email", "c@t.co")
    git(other, "config", "user.name", "colleague")
    rel = w.family.main_file(w.sender).relative_to(w.sender)
    (other / rel).write_text("colleague rewrote it\n", encoding="utf-8")
    git(other, "commit", "-qam", "theirs")
    git(other, "push", "-q", "origin", BRANCH)

    w.write_asset("my rewrite")
    fixed = await _fix(w, "commit")
    assert not fixed["ok"] and fixed["kind"] == "conflict", fixed
    assert str(rel) in fixed["conflicted"], fixed
    assert not fixed["preflight"]["available"]


@pytest.mark.parametrize("family", ["markdown"])
async def test_a9_detached_head_is_named(sender, family):
    w = await sender(family)
    git(w.sender, "checkout", "-q", "--detach")
    assert (await _preflight(w))["code"] == "detached-head"


@pytest.mark.parametrize("family", ["markdown"])
async def test_a11_plain_path_remote_is_not_shareable(sender, family):
    """A remote that is a path on this disk (the Spora case) cannot be reached
    from another machine."""
    w = await sender(family)
    git(w.sender, "remote", "set-url", "origin", str(w.remote))
    r = await _preflight(w)
    assert not r["available"] and r["code"] in ("unsupported-origin", "missing-remote"), r
