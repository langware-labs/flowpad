"""Receiver-side matrix: what a git share does to the receiver's machine.

Contract (one row per receiver state × asset family):
  * the receiver opens EXACTLY the shared commit's bytes, even if the sender's
    branch moved on after sharing;
  * the receiver's own working copy is never touched — same HEAD, same branch,
    dirty files byte-identical;
  * the received row points at a checkout of the pinned commit;
  * one clone per remote: a receiver that already has the repo gets no second
    full clone.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.responses.response import ApiSuccessResponse
from tests.unit.git_share._world import BRANCH, git, head_of, snapshot

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FAMILIES = ["skill", "markdown", "chart"]


def _assert_pinned(w, row, pinned: str, token: str):

    assert row is not None, "receiver never materialized the shared row"
    ref = Path(row.asset_ref)
    main = ref / w.family.main if w.family.main else ref
    assert token in main.read_text(encoding="utf-8"), f"receiver does not see the shared bytes at {main}"
    checkout = Path(git(ref if ref.is_dir() else ref.parent, "rev-parse", "--show-toplevel"))
    assert head_of(checkout) == pinned, "receiver checkout is not at the shared commit"
    return checkout


@pytest.mark.parametrize("family", FAMILIES)
async def test_b1_no_clone(make_world, family):
    w = make_world(family)
    pinned = w.sender_commit()
    res, row = await w.share(project_root=None)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        _assert_pinned(w, row, pinned, w.token)


@pytest.mark.parametrize("family", FAMILIES)
async def test_b2_same_branch_clean(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone()
    before = snapshot(mine)
    pinned = w.sender_commit()
    res, row = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        _assert_pinned(w, row, pinned, w.token)
        assert snapshot(mine) == before


@pytest.mark.parametrize("family", FAMILIES)
async def test_b3_receiver_on_other_branch(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone(branch="main")
    before = snapshot(mine)
    pinned = w.sender_commit()
    res, row = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        checkout = _assert_pinned(w, row, pinned, w.token)
        assert snapshot(mine) == before, "the receiver's own checkout was switched or modified"
        common = git(checkout, "rev-parse", "--git-common-dir")
        assert (mine / ".git").resolve() == (checkout / common).resolve(), "a second full clone was made"


@pytest.mark.parametrize("family", FAMILIES)
async def test_b4_receiver_has_own_edits(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone()
    f = w.family.main_file(mine)
    f.write_text("my local edit\n", encoding="utf-8")
    (mine / "scratch.txt").write_text("untracked\n", encoding="utf-8")
    before = snapshot(mine)
    pinned = w.sender_commit()
    res, row = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        _assert_pinned(w, row, pinned, w.token)
        assert snapshot(mine) == before, "the receiver's uncommitted edits were touched"


@pytest.mark.parametrize("family", FAMILIES)
async def test_c1_sender_moves_on_after_sharing(make_world, family):
    """The receiver installs AFTER the sender pushed a newer commit: it must
    still open the version that was shared."""
    w = make_world(family)
    mine = w.receiver_clone()
    pinned = w.sender_commit()
    shared_token = w.token

    def sender_moves_on():
        w.write_asset("newer-version-token")
        git(w.sender, "commit", "-qam", "newer")
        git(w.sender, "push", "-q", "origin", BRANCH)

    res, row = await w.share(project_root=mine, before_unpack=sender_moves_on)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        _assert_pinned(w, row, pinned, shared_token)


# --- reuse and re-share -------------------------------------------------------


@pytest.mark.parametrize("family", FAMILIES)
async def test_b7_second_share_of_same_commit_reuses_the_checkout(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone(branch="main")
    _, first = await w.share(project_root=mine)
    _, again = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert again.asset_ref == first.asset_ref
        assert len(git(mine, "worktree", "list").splitlines()) == 2, "a duplicate worktree was made"


@pytest.mark.parametrize("family", FAMILIES)
async def test_c2_sender_shares_a_newer_version(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone(branch="main")
    await w.share(project_root=mine)
    w.write_asset("second-version-token")
    git(w.sender, "commit", "-qam", "v2")
    git(w.sender, "push", "-q", "origin", BRANCH)
    v2 = w.sender_commit()
    res, row = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        _assert_pinned(w, row, v2, "second-version-token")


# --- the remote can no longer give the shared version -------------------------


def _fails_cleanly(w, res, row, code: str):
    assert not isinstance(res, ApiSuccessResponse), "install claimed success"
    got = (getattr(res, "data", None) or {}).get("git_share_error")
    assert got == code, f"expected reason {code!r}, got {got!r} ({getattr(res, 'message', res)!r})"
    assert "status code" not in (getattr(res, "message", "") or ""), "the reason must be a sentence for a person"
    assert row is None, "a half-installed row was left behind"


@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("already_fetched", [True, False])
async def test_b9_shared_commit_was_force_pushed_away(make_world, family, already_fetched):
    """Gone from the remote: a receiver that already fetched it still opens it
    (the bytes are on this disk); one that never did gets ``commit-gone``."""
    w = make_world(family)
    mine = w.receiver_clone(branch="main") if already_fetched else None

    def history_rewritten():
        git(w.sender, "reset", "-q", "--hard", "HEAD~1")
        git(w.sender, "commit", "-q", "--allow-empty", "-m", "rewritten")
        git(w.sender, "push", "-q", "--force", "origin", BRANCH)
        git(w.remote, "reflog", "expire", "--expire=now", "--all")
        git(w.remote, "gc", "-q", "--prune=now")

    res, row = await w.share(project_root=mine, before_unpack=history_rewritten)
    async with w.phase("assert"):
        if already_fetched:
            assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        else:
            _fails_cleanly(w, res, row, "commit-gone")


@pytest.mark.parametrize("family", FAMILIES)
async def test_b10_remote_unreachable_and_no_clone(make_world, family):
    import shutil

    w = make_world(family)
    res, row = await w.share(project_root=None, before_unpack=lambda: shutil.rmtree(w.remote))
    async with w.phase("assert"):
        _fails_cleanly(w, res, row, "no-access")


async def test_a_shared_chart_brings_its_sibling_charts_and_icon_packs(make_world):
    """A chart opens its sub-flows (sibling charts, by name) and draws logos
    from icon packs: sharing ONE chart makes those findable on the receiver too."""
    import json
    import uuid

    from flow_sdk.builtin.chart import Chart
    from flow_sdk.core import Entity

    w = make_world("chart")
    sib_id = str(uuid.uuid4())
    sib = w.sender / "docs" / "network" / "spora-oauth-init" / "CHART.md"
    sib.parent.mkdir(parents=True)
    sib.write_text(f"---\nid: {sib_id}\nname: spora-oauth-init\n---\n\n# oauth init\n", encoding="utf-8")
    pack = w.sender / "agentic-assets" / "icon_pack" / "spora-vendors"
    (pack / "assets").mkdir(parents=True)
    (pack / "assets" / "sonos.svg").write_text("<svg/>", encoding="utf-8")
    (pack / "icon_pack.json").write_text(
        json.dumps({"version": 1, "kind": "spora-vendors", "icons": [{"kind": "sonos", "asset": "assets/sonos.svg"}]}),
        encoding="utf-8",
    )
    git(w.sender, "add", "-A")
    git(w.sender, "commit", "-qm", "siblings")
    git(w.sender, "push", "-q", "origin", BRANCH)

    res, row = await w.share(project_root=None)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        sibling = await Chart.get_one({"id": sib_id})
        assert sibling is not None, "the sibling chart a sub-flow opens is not on the receiver"
        assert Path(sibling.asset_ref).parent == Path(row.asset_ref).parent, "the sibling is not beside it"
        packs = [p for p in await Entity.search("spora-vendors", record_type="icon_pack")]
        assert packs, "the icon pack the chart draws logos from is not on the receiver"
