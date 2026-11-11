"""The receive verbs over the real graph routes: ``open-shared`` answers the plan
without writing, the same call with ``apply`` brings it in; ``git_share_update``
does the same for a newer version; a bad body is refused."""

from __future__ import annotations

import pytest

from tests.unit._graph_client import call_local
from tests.unit.git_share._world import BRANCH, git, shared_dirs, snapshot

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


async def test_open_shared_answers_the_plan_then_applies_it(make_world):
    w = make_world("markdown")
    mine = w.receiver_clone(branch="main")
    before = snapshot(mine)
    ma_id, _ = await w.share(project_root=mine, install=False)

    asked = await call_local("POST", f"message_attachment/{ma_id}/open-shared", json={})
    assert asked.status_code == 200, asked.text
    data = asked.json()["data"]
    assert data["needs"] == "apply", data
    assert data["plan"]["action"] == "cherry_pick" and data["plan"]["commits"] == [w.sender_commit()]
    assert data["plan"]["branch"] == "main" and data["project_id"]
    assert snapshot(mine) == before, "the plan step wrote the receiver's checkout"

    done = await call_local(
        "POST", f"message_attachment/{ma_id}/open-shared", json={"project_id": data["project_id"], "apply": True}
    )
    assert done.status_code == 200, done.text
    assert "needs" not in done.json()["data"], done.json()
    assert w.token in w.family.main_file(mine).read_text(encoding="utf-8")
    assert not shared_dirs(w.root)


async def test_git_share_update_route_plans_then_applies(make_world):
    w = make_world("markdown")
    mine = w.receiver_clone(branch="main")
    await w.share(project_root=mine, apply=True)
    w.write_asset("v2-token")
    git(w.sender, "commit", "-qam", "v2")
    git(w.sender, "push", "-q", "origin", BRANCH)
    path = f"{w.family.type}/{w.asset_id}/git_share_update"

    asked = (await call_local("POST", path, json={})).json()["data"]
    assert asked["needs"] == "apply" and asked["plan"]["action"] == "cherry_pick", asked
    done = (await call_local("POST", path, json={"apply": True})).json()["data"]
    assert done["updated"], done
    assert "v2-token" in w.family.main_file(mine).read_text(encoding="utf-8")

    bad = await call_local("POST", path, json={"apply": True, "sender": "x"})
    assert bad.status_code == 400, "a misspelled key must be refused, not ignored"


async def test_send_back_is_gone(make_world):
    w = make_world("markdown")
    res = await call_local("POST", f"{w.family.type}/{w.asset_id}/git_share_send_back", json={})
    assert res.status_code in (404, 405, 400), res.text
