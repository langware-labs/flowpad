"""Publishing also puts the DOCUMENT on the hub — when it can. The toggle never
waits on GitHub: the share path (``publish_git_asset``) and the hub snapshot
(``gitops/materialize``) run in the background, and the desk's published view
reports what happened as ``hub_body`` so the row can say why the document is
(not) readable on the hub."""
from __future__ import annotations

import pytest

import flow_sdk.builtin.project_manifest as pm
from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError
from flow_sdk.fs_store.record_types import RecordType
from tests.api._published import entity_row, index, project, toggle, write_skill

pytestmark = pytest.mark.asyncio

BRANCH_AHEAD = AssetPublishError(AssetPublishCode.BRANCH_AHEAD, "local HEAD is ahead")


@pytest.mark.parametrize(
    ("linked", "token", "publish_raises", "expected", "publishes"),
    [
        (False, "gh-token", None, {"status": "skipped", "code": "project_not_linked"}, False),
        (True, None, None, {"status": "skipped", "code": "github_not_connected"}, False),
        (True, "gh-token", BRANCH_AHEAD, {"status": "failed", "code": "branch_ahead"}, True),
        (True, "gh-token", None, {"status": "published", "code": None}, True),
    ],
    ids=["unlinked-project", "no-github", "share-refused", "published-and-materialized"],
)
async def test_the_toggle_reports_what_it_did_about_the_hub_body(
    bootstrapped_client, tmp_path, monkeypatch, linked, token, publish_raises, expected, publishes
):
    calls = {"publish": [], "materialize": []}

    async def fake_token(actor):
        return token

    async def fake_publish(entity, actor):
        calls["publish"].append(str(entity.typeid))
        if publish_raises is not None:
            raise publish_raises
        return {"asset": {}}

    async def fake_post(entity_type, payload, entity_id=None, action=None, sub_path=None, **kw):
        if action == "gitops":
            calls["materialize"].append((entity_type, entity_id, sub_path))
        return {}

    monkeypatch.setattr("flow_sdk.core.oauth.github_credentials.get_github_token", fake_token)
    monkeypatch.setattr("flow_sdk.assets.git_publish.publish_git_asset", fake_publish)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake_post)

    pid = await project(bootstrapped_client, tmp_path)
    write_skill(tmp_path, "rca")
    await index(tmp_path, pid, RecordType.SKILL)
    skill = await entity_row(bootstrapped_client, "skill", pid, "rca")
    if linked:
        await bootstrapped_client.put(f"/api/v1/graph/project/{pid}", json={"remote": True})

    assert (await toggle(bootstrapped_client, "skill", skill["id"], True)).status_code == 200, "the row is written regardless"
    await pm.drain_hub_tasks()
    resp = await bootstrapped_client.get(f"/api/v1/graph/project/{pid}/published")
    (row,) = [r for r in resp.json()["data"]["rows"] if r["typeid"] == f"skill-{skill['id']}"]
    assert row["hub_body"] == expected
    assert (calls["publish"] == [f"skill-{skill['id']}"]) is publishes
    assert calls["materialize"] == ([("skill", skill["id"], "materialize")] if expected["status"] == "published" else [])
