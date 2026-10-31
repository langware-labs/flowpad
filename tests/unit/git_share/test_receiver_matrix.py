"""Receiver-side matrix: what a git share does to the receiver's machine.

Contract (one row per receiver state × asset family):
  * a share comes into the receiver's OWN checkout — never a second copy
    (no ``.shared`` worktree, no hidden clone); the row points into the project;
  * ``have``: a checkout that already holds the shared version of the asset
    (even if HEAD moved on) opens in place and writes nothing;
  * ``pull``: on the shared branch, behind → a pull, only with consent;
  * ``cherry_pick``: anywhere else → ``cherry-pick -x`` of the commits that
    touch the asset, only with consent; other files they change are listed;
  * without consent nothing is written and the plan comes back (``needs: apply``);
  * the receiver's uncommitted edits survive; a conflict is left for Resolve.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.responses.response import ApiSuccessResponse
from tests.unit.git_share._world import BRANCH, git, head_of, shared_dirs, snapshot

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FAMILIES = ["skill", "markdown", "chart"]


def _data(res) -> dict:
    return getattr(res, "data", None) or {}


def _assert_in_project(w, row, mine: Path, token: str) -> None:
    assert row is not None, "receiver never materialized the shared row"
    ref = Path(row.asset_ref)
    assert ref.resolve() == (mine / w.family.rel_path).resolve(), f"the asset is not in the project: {ref}"
    main = ref / w.family.main if w.family.main else ref
    assert token in main.read_text(encoding="utf-8"), f"receiver does not see the shared bytes at {main}"
    assert not shared_dirs(w.root), "a .shared copy was made"


def _needs_apply(res, action: str) -> dict:
    assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
    assert _data(res).get("needs") == "apply", f"expected a plan to confirm, got {_data(res)!r}"
    plan = _data(res)["plan"]
    assert plan["action"] == action, plan
    return plan


# --- have: nothing to bring in ------------------------------------------------


@pytest.mark.parametrize("family", FAMILIES)
async def test_have_same_branch_at_commit_opens_in_place(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone()
    before = snapshot(mine)
    res, row = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse) and not _data(res).get("needs"), _data(res)
        _assert_in_project(w, row, mine, w.token)
        assert snapshot(mine) == before


@pytest.mark.parametrize("family", FAMILIES)
async def test_have_receiver_ahead_with_unrelated_commit(make_world, family):
    """HEAD moved on (a commit that never touched the asset): still ``have``."""
    w = make_world(family)
    mine = w.receiver_clone()
    (mine / "other.txt").write_text("mine\n", encoding="utf-8")
    git(mine, "add", "-A")
    git(mine, "commit", "-qm", "unrelated")
    before = snapshot(mine)
    res, row = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse) and not _data(res).get("needs"), _data(res)
        _assert_in_project(w, row, mine, w.token)
        assert snapshot(mine) == before


@pytest.mark.parametrize("family", FAMILIES)
async def test_sender_pins_the_assets_own_commit(make_world, family):
    """The sender commits elsewhere after the asset: the share pins the asset's
    commit, so a receiver at that commit is ``have`` and a cherry-pick takes
    only the asset's commit."""
    w = make_world(family)
    asset_commit = w.sender_commit()
    (w.sender / "unrelated.txt").write_text("x\n", encoding="utf-8")
    git(w.sender, "add", "-A")
    git(w.sender, "commit", "-qm", "unrelated")
    git(w.sender, "push", "-q", "origin", BRANCH)
    mine = w.receiver_clone(branch="main")
    res, _row = await w.share(project_root=mine)
    async with w.phase("assert"):
        plan = _needs_apply(res, "cherry_pick")
        assert plan["commit"] == asset_commit
        assert plan["commits"] == [asset_commit]
        assert plan["other_files"] == []


# --- pull: behind on the shared branch ----------------------------------------


@pytest.mark.parametrize("family", FAMILIES)
async def test_pull_behind_on_the_shared_branch(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone()
    w.write_asset("v2-token")
    git(w.sender, "commit", "-qam", "v2")
    git(w.sender, "push", "-q", "origin", BRANCH)
    before = snapshot(mine)

    res, _ = await w.share(project_root=mine)
    async with w.phase("assert-plan"):
        _needs_apply(res, "pull")
        assert snapshot(mine) == before, "the plan step wrote the receiver's checkout"

    res, row = await w.share(project_root=mine, apply=True)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse) and not _data(res).get("needs"), getattr(res, "message", res)
        _assert_in_project(w, row, mine, "v2-token")
        assert head_of(mine) == w.sender_commit(), "a pull keeps one history with the remote"


@pytest.mark.parametrize("family", FAMILIES)
async def test_pull_keeps_unrelated_uncommitted_edits(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone()
    w.write_asset("v2-token")
    git(w.sender, "commit", "-qam", "v2")
    git(w.sender, "push", "-q", "origin", BRANCH)
    (mine / "README.md").write_text("my unsaved edit\n", encoding="utf-8")
    res, row = await w.share(project_root=mine, apply=True)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        _assert_in_project(w, row, mine, "v2-token")
        assert (mine / "README.md").read_text(encoding="utf-8") == "my unsaved edit\n"


# --- cherry-pick: another branch ----------------------------------------------


@pytest.mark.parametrize("family", FAMILIES)
async def test_cherry_pick_onto_another_branch(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone(branch="main")
    before = snapshot(mine)

    res, _ = await w.share(project_root=mine)
    async with w.phase("assert-plan"):
        plan = _needs_apply(res, "cherry_pick")
        assert plan["commits"] == [w.sender_commit()]
        assert plan["branch"] == "main"
        assert snapshot(mine) == before, "the plan step wrote the receiver's checkout"

    res, row = await w.share(project_root=mine, apply=True)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse) and not _data(res).get("needs"), getattr(res, "message", res)
        _assert_in_project(w, row, mine, w.token)
        assert git(mine, "rev-parse", "--abbrev-ref", "HEAD") == "main", "the receiver's branch was switched"
        assert f"cherry picked from commit {w.sender_commit()}" in git(mine, "log", "-1", "--format=%B")


@pytest.mark.parametrize("family", FAMILIES)
async def test_cherry_pick_brings_the_assets_whole_history(make_world, family):
    """The asset changed over two commits the receiver has neither of: both come, oldest first."""
    w = make_world(family)
    first = w.sender_commit()
    w.write_asset("v2-token")
    git(w.sender, "commit", "-qam", "v2")
    git(w.sender, "push", "-q", "origin", BRANCH)
    mine = w.receiver_clone(branch="main")
    res, _ = await w.share(project_root=mine)
    async with w.phase("assert-plan"):
        assert _needs_apply(res, "cherry_pick")["commits"] == [first, w.sender_commit()]
    res, row = await w.share(project_root=mine, apply=True)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        _assert_in_project(w, row, mine, "v2-token")


async def test_cherry_pick_lists_other_files_the_commit_changes(make_world):
    w = make_world("markdown")
    w.write_asset("v2-token")
    (w.sender / "code.py").write_text("print(1)\n", encoding="utf-8")
    git(w.sender, "add", "-A")
    git(w.sender, "commit", "-qm", "asset and code")
    git(w.sender, "push", "-q", "origin", BRANCH)
    mine = w.receiver_clone(branch="main")
    res, _ = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert _needs_apply(res, "cherry_pick")["other_files"] == ["code.py"]


async def test_cherry_pick_conflict_is_left_for_resolve(make_world):
    w = make_world("markdown")
    mine = w.receiver_clone(branch="main")
    f = w.family.main_file(mine)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("the receiver's own version\n", encoding="utf-8")
    git(mine, "add", "-A")
    git(mine, "commit", "-qm", "mine")
    res, row = await w.share(project_root=mine, apply=True)
    async with w.phase("assert"):
        assert not isinstance(res, ApiSuccessResponse)
        data = _data(res)
        assert data.get("git_share_error") == "conflict", data
        assert data.get("operation") == "cherry-pick"
        assert data.get("conflicted") == [w.family.rel_path]
        assert Path(data.get("workdir")).resolve() == mine.resolve()
        assert git(mine, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"), "the conflict was aborted, not left"
        assert "<<<<<<<" in f.read_text(encoding="utf-8"), "the copy was laid over the conflict"


# --- no checkout / the remote cannot give it ----------------------------------


def _fails_cleanly(w, res, row, code: str):
    assert not isinstance(res, ApiSuccessResponse), "install claimed success"
    got = _data(res).get("git_share_error")
    assert got == code, f"expected reason {code!r}, got {got!r} ({getattr(res, 'message', res)!r})"
    assert "status code" not in (getattr(res, "message", "") or ""), "the reason must be a sentence for a person"
    assert row is None, "a half-installed row was left behind"
    assert not shared_dirs(w.root), "a .shared copy was made"


@pytest.mark.parametrize("family", FAMILIES)
async def test_no_checkout_makes_no_hidden_clone(make_world, family):
    w = make_world(family)
    res, row = await w.share(project_root=None)
    async with w.phase("assert"):
        _fails_cleanly(w, res, row, "no-checkout")


@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("already_fetched", [True, False])
async def test_shared_commit_was_force_pushed_away(make_world, family, already_fetched):
    """Gone from the remote: a receiver that already fetched it still brings it in
    (the commit is on this disk); one that never did gets ``commit-gone``."""
    w = make_world(family)
    if already_fetched:
        mine = w.receiver_clone(branch="main")
    else:
        mine = w.receiver_clone(name="early", branch="main")
        git(mine, "reset", "-q", "--hard", "origin/main")
        git(mine, "branch", "-q", "-r", "-D", f"origin/{BRANCH}")
        git(mine, "reflog", "expire", "--expire=now", "--all")
        git(mine, "gc", "-q", "--prune=now")

    def history_rewritten():
        git(w.sender, "reset", "-q", "--hard", "HEAD~1")
        git(w.sender, "commit", "-q", "--allow-empty", "-m", "rewritten")
        git(w.sender, "push", "-q", "--force", "origin", BRANCH)
        git(w.remote, "reflog", "expire", "--expire=now", "--all")
        git(w.remote, "gc", "-q", "--prune=now")

    res, row = await w.share(project_root=mine, before_unpack=history_rewritten, apply=True)
    async with w.phase("assert"):
        if already_fetched:
            assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
            _assert_in_project(w, row, mine, w.token)
        else:
            _fails_cleanly(w, res, row, "commit-gone")


@pytest.mark.parametrize("family", FAMILIES)
async def test_remote_unreachable_for_a_commit_not_fetched(make_world, family):
    import shutil

    w = make_world(family)
    mine = w.receiver_clone()
    w.write_asset("v2-token")
    git(w.sender, "commit", "-qam", "v2")
    git(w.sender, "push", "-q", "origin", BRANCH)
    res, row = await w.share(project_root=mine, before_unpack=lambda: shutil.rmtree(w.remote))
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
    sib = w.sender / "docs" / "network" / "acme-oauth-init" / "CHART.md"
    sib.parent.mkdir(parents=True)
    sib.write_text(f"---\nid: {sib_id}\nname: acme-oauth-init\n---\n\n# oauth init\n", encoding="utf-8")
    pack = w.sender / "agentic-assets" / "icon_pack" / "acme-vendors"
    (pack / "assets").mkdir(parents=True)
    (pack / "assets" / "sonos.svg").write_text("<svg/>", encoding="utf-8")
    (pack / "icon_pack.json").write_text(
        json.dumps({"version": 1, "kind": "acme-vendors", "icons": [{"kind": "sonos", "asset": "assets/sonos.svg"}]}),
        encoding="utf-8",
    )
    git(w.sender, "add", "-A")
    git(w.sender, "commit", "-qm", "siblings")
    git(w.sender, "push", "-q", "origin", BRANCH)

    mine = w.receiver_clone()
    res, row = await w.share(project_root=mine)
    async with w.phase("assert"):
        assert isinstance(res, ApiSuccessResponse), getattr(res, "message", res)
        sibling = await Chart.get_one({"id": sib_id})
        assert sibling is not None, "the sibling chart a sub-flow opens is not on the receiver"
        assert Path(sibling.asset_ref).parent == Path(row.asset_ref).parent, "the sibling is not beside it"
        packs = [p for p in await Entity.search("acme-vendors", record_type="icon_pack")]
        assert packs, "the icon pack the chart draws logos from is not on the receiver"
