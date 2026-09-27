"""Publishing also puts the DOCUMENT on the hub — when it can. The toggle never
waits on it: pushing the asset into the project's hub-hosted repo
(``publish_git_asset``) runs in the background, and the desk's published view
reports what happened as ``hub_body`` so the row can say why the document is
(not) readable on the hub. Once it lands, the manifest row points at the hub
repo and the manifest is reflected to the hub again."""
from __future__ import annotations

import pytest

import flow_sdk.builtin.project_manifest as pm
from flow_sdk.assets.git_publish import AssetPublishCode, AssetPublishError
from flow_sdk.fs_store.origin.hub_repo_origin import HubRepoOrigin
from flow_sdk.fs_store.record_types import RecordType
from tests.api._published import entity_row, index, project, toggle, write_skill

pytestmark = pytest.mark.asyncio

REPO = "git_repo-" + "1" * 32
CONFLICT = AssetPublishError(AssetPublishCode.ASSET_CONFLICT, "changed on the hub and here")


@pytest.mark.parametrize(
    ("linked", "publish_raises", "expected", "publishes"),
    [
        (False, None, {"status": "skipped", "code": "project_not_linked"}, False),
        (True, CONFLICT, {"status": "failed", "code": "asset_conflict"}, True),
        (True, None, {"status": "published", "code": None}, True),
    ],
    ids=["unlinked-project", "publish-refused", "published-into-hub-repo"],
)
async def test_the_toggle_reports_what_it_did_about_the_hub_body(
    bootstrapped_client, tmp_path, monkeypatch, linked, publish_raises, expected, publishes
):
    calls = {"publish": [], "manifest": []}

    async def fake_publish(entity, actor):
        calls["publish"].append(str(entity.typeid))
        if publish_raises is not None:
            raise publish_raises
        entity.origin = HubRepoOrigin(repo=REPO, rel_path=".claude/skills/rca", head_commit="a" * 40, tree="b" * 40)
        return {"asset": {}}

    async def fake_post(entity_type, payload, entity_id=None, action=None, sub_path=None, **kw):
        if action == "publish_manifest":
            calls["manifest"].append(payload["manifest"])
        return {}

    monkeypatch.setattr("flow_sdk.builtin.asset_publishing.publish_git_asset", fake_publish)
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

    if expected["status"] == "published":
        # A reader installs from the row's origin, so it must name the hub repo.
        assert row["origin"]["kind"] == "hub_repo"
        assert (row["origin"]["repo"], row["origin"]["rel_path"]) == (REPO, ".claude/skills/rca")
        assert calls["manifest"], "the re-pointed manifest was reflected to the hub"
    else:
        assert (row["origin"] or {}).get("kind") != "hub_repo"
