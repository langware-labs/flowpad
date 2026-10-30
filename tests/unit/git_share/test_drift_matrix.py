"""After the share: newer versions, and the receiver's own edits.

Contract:
  * the receiver sees how many newer commits on the shared branch touch the
    asset and are not on their branch yet (a cherry-picked one counts as there);
  * update without consent answers the plan and writes nothing; with consent it
    pulls (on the shared branch) or cherry-picks (anywhere else) — the asset
    stays at its project path, the index and the row's commit follow;
  * the receiver's uncommitted edits are never lost: they come back on top, or
    are left as a conflict for Resolve.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.app.actions.git_share_drift_action import git_share_status, git_share_update
from flow_sdk.core import Entity
from tests.unit.git_share._world import BRANCH, git, shared_dirs

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FAMILIES = ["skill", "markdown", "chart"]


async def _received(make_world, family, branch: str = "main"):
    w = make_world(family)
    mine = w.receiver_clone(branch=branch)
    _res, row = await w.share(project_root=mine, apply=True)
    assert row is not None
    return w, mine, row


def _sender_pushes(w, token: str) -> str:
    w.write_asset(token)
    git(w.sender, "commit", "-qam", token)
    git(w.sender, "push", "-q", "origin", BRANCH)
    return w.sender_commit()


def _main(w, row) -> Path:
    ref = Path(row.asset_ref)
    return ref / w.family.main if w.family.main else ref


@pytest.mark.parametrize("family", FAMILIES)
async def test_up_to_date_after_a_cherry_pick(make_world, family):
    w, _mine, _row = await _received(make_world, family)
    async with w.phase("status"):
        st = await git_share_status(w.family.type, w.asset_id)
    assert st["shared"] and st["behind"] == 0 and not st["edited"], st


@pytest.mark.parametrize("family", FAMILIES)
async def test_newer_commits_are_counted_and_update_brings_the_latest(make_world, family):
    w, mine, row = await _received(make_world, family)
    path = Path(row.asset_ref)
    _sender_pushes(w, "v2-token")
    _sender_pushes(w, "v3token")
    (w.sender / "unrelated.txt").write_text("x\n", encoding="utf-8")
    git(w.sender, "add", "-A")
    git(w.sender, "commit", "-qm", "unrelated")
    git(w.sender, "push", "-q", "origin", BRANCH)

    async with w.phase("status"):
        st = await git_share_status(w.family.type, w.asset_id)
    assert st["behind"] == 2, f"only commits touching the asset count: {st}"

    async with w.phase("plan"):
        asked = await git_share_update(w.family.type, w.asset_id)
    assert asked.get("needs") == "apply" and asked["plan"]["action"] == "cherry_pick", asked
    assert len(asked["plan"]["commits"]) == 2
    assert "v3token" not in _main(w, row).read_text(encoding="utf-8"), "the plan step wrote the checkout"

    async with w.phase("update"):
        up = await git_share_update(w.family.type, w.asset_id, apply=True)
    assert up["updated"], up
    latest = await w.family.entity_cls.get_one({"id": w.asset_id})
    assert Path(latest.asset_ref) == path, "the asset moved out of the project"
    assert "v3token" in _main(w, latest).read_text(encoding="utf-8")
    assert git(mine, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert not shared_dirs(w.root)
    hits = await Entity.search("v3token", record_type=w.family.type)
    assert any(h.id == w.asset_id for h in hits), "the updated version is not what search finds"
    assert (await git_share_status(w.family.type, w.asset_id))["behind"] == 0


@pytest.mark.parametrize("family", FAMILIES)
async def test_update_on_the_shared_branch_is_a_pull(make_world, family):
    w, mine, row = await _received(make_world, family, branch=BRANCH)
    tip = _sender_pushes(w, "v2-token")
    asked = await git_share_update(w.family.type, w.asset_id)
    assert asked["plan"]["action"] == "pull", asked
    up = await git_share_update(w.family.type, w.asset_id, apply=True)
    assert up["updated"], up
    assert git(mine, "rev-parse", "HEAD") == tip
    assert "v2-token" in _main(w, row).read_text(encoding="utf-8")


@pytest.mark.parametrize("family", ["markdown"])
async def test_update_never_loses_the_receivers_edits(make_world, family):
    w, mine, row = await _received(make_world, family)
    _main(w, row).write_text("receiver's own rewrite\n", encoding="utf-8")
    _sender_pushes(w, "sender-v2")
    assert (await git_share_status(w.family.type, w.asset_id))["edited"]
    async with w.phase("update"):
        up = await git_share_update(w.family.type, w.asset_id, apply=True)
    assert (up["updated"], up["code"]) == (False, "conflict"), up
    assert up["operation"] == "cherry-pick"
    text = _main(w, row).read_text(encoding="utf-8")
    assert "receiver's own rewrite" in text and "sender-v2" in text, "an edit was dropped instead of merged"
