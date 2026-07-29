"""Pushing a secret to the hub, and deleting it from the hub ONLY.

The hub is the system of record, so the push reuses the hub's own env-var
action rather than building a second secret manager. What these tests exist to
pin is the other half: "delete from cloud" means the cloud and nothing else.
"""

import pytest

from flow_sdk.builtin.env_local_store import write_env_local
from flow_sdk.builtin.project import Project
from flow_sdk.schema.type_info import register_all

register_all()


async def _project(tmp_path, published: bool):
    project = Project(name=str(tmp_path / "cloud-proj"))
    project.fs_storage_mount_path = str(tmp_path)
    if published:
        project.hub_published_at = "2026-07-29T00:00:00+00:00"
    await project.save()
    return project


@pytest.mark.asyncio
async def test_push_is_refused_and_makes_no_hub_call_when_unpublished(tmp_path, monkeypatch, sod_env):
    calls = []

    async def spy(*a, **k):
        calls.append((a, k))
        return {}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", spy)
    project = await _project(tmp_path, published=False)

    resp = await project.push_secret_to_cloud(env_var="OPENAI_API_KEY", value="sk-1")

    assert resp.status == "FAIL"
    assert resp.data["error"] == "project_not_published"
    assert calls == [], "an unpublished project must not reach the hub at all"


@pytest.mark.asyncio
async def test_push_sends_the_secret_to_the_hubs_own_env_var_action(tmp_path, monkeypatch, sod_env):
    seen = {}

    async def spy(entity_type, body, entity_id=None, action=None, **k):
        seen.update({"entity_id": entity_id, "action": action, "body": body})
        return {"status": "SUCCESS"}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_post", spy)
    project = await _project(tmp_path, published=True)

    resp = await project.push_secret_to_cloud(env_var="OPENAI_API_KEY", value="sk-cloud")

    assert resp.status == "SUCCESS", resp
    assert seen["entity_id"] == str(project.id)
    assert seen["action"] == "env-var"
    assert seen["body"]["name"] == "OPENAI_API_KEY"
    # var_type must be explicit — an unclassified value is stored in the clear.
    assert seen["body"]["var_type"] == "api_key"
    # ...and the local declaration now points at the hub copy.
    row = next(r for r in project.secret_origins if r["env_var"] == "OPENAI_API_KEY")
    assert row["locator"]["kind"] == "flowpad-hub"
    assert row["locator"]["project_id"] == str(project.id)


@pytest.mark.asyncio
async def test_delete_from_cloud_touches_nothing_local(tmp_path, monkeypatch, sod_env):
    """The whole of 'delete from cloud and ONLY from cloud', in one assertion
    block. If this test ever has to change, something has quietly widened."""
    seen = {}

    async def spy(entity_type, entity_id=None, action=None, sub_path=None, **k):
        seen.update({"entity_id": entity_id, "action": action, "sub_path": sub_path})
        return {"status": "SUCCESS"}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_delete", spy)
    project = await _project(tmp_path, published=True)
    await project.add_secret_pointer(
        name="openai", env_var="OPENAI_API_KEY", scope="private",
        locator={"kind": "env-local", "env_key": "OPENAI_API_KEY"},
    )
    write_env_local(project, "OPENAI_API_KEY", "sk-still-here")
    before_declarations = [dict(r) for r in project.secret_origins]
    before_env_local = (tmp_path / ".env.local").read_text()
    before_sidecar = (tmp_path / "assets" / "sodot" / "OPENAI_API_KEY.json").read_text()

    resp = await project.delete_secret_from_cloud(env_var="OPENAI_API_KEY")

    assert resp.status == "SUCCESS", resp
    assert seen == {"entity_id": str(project.id), "action": "env-var", "sub_path": "OPENAI_API_KEY"}
    assert [dict(r) for r in project.secret_origins] == before_declarations
    assert (tmp_path / ".env.local").read_text() == before_env_local
    assert (tmp_path / "assets" / "sodot" / "OPENAI_API_KEY.json").read_text() == before_sidecar


@pytest.mark.asyncio
async def test_delete_from_cloud_is_refused_when_unpublished(tmp_path, monkeypatch, sod_env):
    calls = []

    async def spy(*a, **k):
        calls.append(a)
        return {}

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_delete", spy)
    project = await _project(tmp_path, published=False)

    resp = await project.delete_secret_from_cloud(env_var="OPENAI_API_KEY")

    assert resp.status == "FAIL"
    assert calls == []
