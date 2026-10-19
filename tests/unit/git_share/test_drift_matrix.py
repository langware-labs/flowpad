"""After the share: newer versions, updates, and the receiver's own edits.

Contract:
  * the receiver sees how many newer commits touched the shared asset;
  * update opens the latest version (index + row follow it); the old
    version's share slot (clean, ours) is dropped;
  * an edited copy is never overwritten — update refuses with ``local-edits``;
  * send back commits the receiver's edits on ``share/<who>/<leaf>`` and
    pushes that branch; the sender's branch is never written, nothing forced.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.app.actions.git_share_drift_action import git_share_send_back, git_share_status, git_share_update
from flow_sdk.core import Entity
from tests.unit.git_share._world import BRANCH, git

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FAMILIES = ["skill", "markdown", "chart"]


async def _received(make_world, family):
    w = make_world(family)
    mine = w.receiver_clone(branch="main")
    _res, row = await w.share(project_root=mine)
    return w, row


def _sender_pushes(w, token: str) -> str:
    w.write_asset(token)
    git(w.sender, "commit", "-qam", token)
    git(w.sender, "push", "-q", "origin", BRANCH)
    return w.sender_commit()


def _main(w, row) -> Path:
    ref = Path(row.asset_ref)
    return ref / w.family.main if w.family.main else ref


@pytest.mark.parametrize("family", FAMILIES)
async def test_up_to_date_reports_nothing_newer(make_world, family):
    w, _row = await _received(make_world, family)
    async with w.phase("status"):
        st = await git_share_status(w.family.type, w.asset_id)
    assert st["shared"] and st["behind"] == 0 and not st["edited"], st


@pytest.mark.parametrize("family", FAMILIES)
async def test_c1_newer_commits_are_counted_and_update_opens_the_latest(make_world, family):
    w, row = await _received(make_world, family)
    old = _main(w, row)
    _sender_pushes(w, "v2-token")
    _sender_pushes(w, "v3token")
    (w.sender / "unrelated.txt").write_text("x\n", encoding="utf-8")
    git(w.sender, "add", "-A")
    git(w.sender, "commit", "-qm", "unrelated")
    git(w.sender, "push", "-q", "origin", BRANCH)

    async with w.phase("status"):
        st = await git_share_status(w.family.type, w.asset_id)
    assert st["behind"] == 2, f"only commits touching the asset count: {st}"

    async with w.phase("update"):
        up = await git_share_update(w.family.type, w.asset_id)
    assert up["updated"], up
    latest = await w.family.entity_cls.get_one({"id": w.asset_id})
    assert "v3token" in _main(w, latest).read_text(encoding="utf-8")
    assert latest.origin.head_commit == git(w.sender, "rev-parse", "HEAD")
    assert not old.exists() or w.token in old.read_text(encoding="utf-8"), "the old copy was rewritten"
    hits = await Entity.search("v3token", record_type=w.family.type)
    assert any(h.id == w.asset_id for h in hits), "the updated version is not what search finds"


@pytest.mark.parametrize("family", FAMILIES)
async def test_c4_update_never_overwrites_the_receivers_edits(make_world, family):
    w, row = await _received(make_world, family)
    _main(w, row).write_text("receiver's own rewrite\n", encoding="utf-8")
    _sender_pushes(w, "sender-v2")
    async with w.phase("update"):
        up = await git_share_update(w.family.type, w.asset_id)
    assert (up["updated"], up["code"]) == (False, "local-edits"), up
    assert _main(w, row).read_text(encoding="utf-8") == "receiver's own rewrite\n"


@pytest.mark.parametrize("family", FAMILIES)
async def test_c3_send_back_pushes_a_share_branch_and_leaves_the_senders_alone(make_world, family):
    w, row = await _received(make_world, family)
    _main(w, row).write_text("improved by the receiver\n", encoding="utf-8")
    sender_tip = git(w.remote, "rev-parse", BRANCH)
    async with w.phase("send_back"):
        sent = await git_share_send_back(w.family.type, w.asset_id, "Bob Smith")
    assert sent["sent"], sent
    assert sent["branch"].startswith("share/Bob-Smith/"), sent
    assert git(w.remote, "rev-parse", sent["branch"]) == sent["commit"]
    assert git(w.remote, "rev-parse", BRANCH) == sender_tip, "the sender's branch was written"
    rel = w.family.main_file(w.sender).relative_to(w.sender)
    assert git(w.remote, "show", f"{sent['branch']}:{rel.as_posix()}") == "improved by the receiver"


@pytest.mark.parametrize("family", ["markdown"])
async def test_c5_both_edit_then_merge_is_a_normal_conflict(make_world, family):
    """Sender and receiver rewrite the same lines: sending back still works
    (a branch of its own), and merging it into the sender's branch is an
    ordinary git conflict — the share itself never forced one."""
    w, row = await _received(make_world, family)
    _main(w, row).write_text("receiver line\n", encoding="utf-8")
    sent = await git_share_send_back(w.family.type, w.asset_id, "bob")
    assert sent["sent"], sent
    _sender_pushes(w, "sender line")
    git(w.sender, "fetch", "-q", "origin")
    merged = git(w.sender, "merge", "--no-edit", f"origin/{sent['branch']}", check=False)
    conflicted = git(w.sender, "diff", "--name-only", "--diff-filter=U")
    assert conflicted, f"expected a merge conflict, got: {merged!r}"
    git(w.sender, "merge", "--abort")
