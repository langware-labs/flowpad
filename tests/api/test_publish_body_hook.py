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


async def _published_skill(client, tmp_path):
    pid = await project(client, tmp_path)
    write_skill(tmp_path, "rca")
    await index(tmp_path, pid, RecordType.SKILL)
    skill = await entity_row(client, "skill", pid, "rca")
    return pid, skill


async def _hub_body(client, pid: str, typeid: str):
    await pm.drain_hub_tasks()
    resp = await client.get(f"/api/v1/graph/project/{pid}/published")
    (row,) = [r for r in resp.json()["data"]["rows"] if r["typeid"] == typeid]
    return row["hub_body"]


def _wire(monkeypatch, *, token="gh-token", publish=None, materialize=None):
    calls = {"publish": [], "materialize": []}

    async def fake_token(actor):
        return token

    async def fake_publish(entity, actor):
        calls["publish"].append((str(entity.typeid), str(actor)))
        if publish is not None:
            raise publish
        return {"asset": {}}

    async def fake_post(entity_type, payload, entity_id=None, action=None, sub_path=None, **kw):
        if action == "gitops":
            calls["materialize"].append((entity_type, entity_id, sub_path))
            if materialize is not None:
                raise materialize
        return {}

    monkeypatch.setattr("flow_sdk.core.oauth.github_credentials.get_github_token", fake_token)
    monkeypatch.setattr("flow_sdk.assets.git_publish.publish_git_asset", fake_publish)
    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", fake_post)
    return calls


async def test_an_unlinked_project_skips_and_says_so(bootstrapped_client, tmp_path, monkeypatch):
    calls = _wire(monkeypatch)
    pid, skill = await _published_skill(bootstrapped_client, tmp_path)
    assert (await toggle(bootstrapped_client, "skill", skill["id"], True)).status_code == 200
    assert await _hub_body(bootstrapped_client, pid, f"skill-{skill['id']}") == {"status": "skipped", "code": "project_not_linked"}
    assert calls["publish"] == [], "nothing touches git for a project that is not linked"


async def test_a_linked_project_with_github_publishes_then_materializes(bootstrapped_client, tmp_path, monkeypatch):
    calls = _wire(monkeypatch)
    pid, skill = await _published_skill(bootstrapped_client, tmp_path)
    await bootstrapped_client.put(f"/api/v1/graph/project/{pid}", json={"remote": True})
    assert (await toggle(bootstrapped_client, "skill", skill["id"], True)).status_code == 200
    assert await _hub_body(bootstrapped_client, pid, f"skill-{skill['id']}") == {"status": "published", "code": None}
    assert [c[0] for c in calls["publish"]] == [f"skill-{skill['id']}"]
    assert calls["materialize"] == [("skill", skill["id"], "materialize")]


async def test_a_share_refusal_is_reported_not_raised(bootstrapped_client, tmp_path, monkeypatch):
    _wire(monkeypatch, publish=AssetPublishError(AssetPublishCode.BRANCH_AHEAD, "local HEAD is ahead"))
    pid, skill = await _published_skill(bootstrapped_client, tmp_path)
    await bootstrapped_client.put(f"/api/v1/graph/project/{pid}", json={"remote": True})
    resp = await toggle(bootstrapped_client, "skill", skill["id"], True)
    assert resp.status_code == 200, "the manifest row is written regardless"
    assert await _hub_body(bootstrapped_client, pid, f"skill-{skill['id']}") == {"status": "failed", "code": "branch_ahead"}


async def test_no_github_connection_skips_before_git(bootstrapped_client, tmp_path, monkeypatch):
    calls = _wire(monkeypatch, token=None)
    pid, skill = await _published_skill(bootstrapped_client, tmp_path)
    await bootstrapped_client.put(f"/api/v1/graph/project/{pid}", json={"remote": True})
    assert (await toggle(bootstrapped_client, "skill", skill["id"], True)).status_code == 200
    assert await _hub_body(bootstrapped_client, pid, f"skill-{skill['id']}") == {"status": "skipped", "code": "github_not_connected"}
    assert calls["publish"] == []
