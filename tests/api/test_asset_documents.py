"""Document and destination contracts through the real graph/FS dispatcher."""
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid

pytestmark = pytest.mark.asyncio


async def project_at(client, path):
    response = await client.post("/api/v1/graph/project", json={"name": "asset-documents", "fs_storage_mount_path": str(path)})
    assert response.status_code == 200, response.text
    return response.json()["data"]["id"]


async def test_document_action_updates_selected_occurrence_and_rejects_stale(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await project_at(client, tmp_path)
    text = f"---\nid: {mint_uuid()}\ntags: [a, b]\n---\nbody\n"
    for name in ("first", "second"):
        folder = tmp_path / ".claude" / "skills" / name
        folder.mkdir(parents=True)
        (folder / "SKILL.md").write_text(text)
    route = f"/api/v1/graph/project/{project}/fs/document/.claude/skills/second/SKILL.md"
    loaded = await client.get(route)
    assert loaded.status_code == 200, loaded.text
    revision = loaded.json()["data"]["revision"]
    saved = await client.post(route, json={"expected_revision": revision, "body": "edited\n", "set_fields": {"eval": True}})
    assert saved.status_code == 200, saved.text
    assert saved.json()["data"]["fields"]["tags"] == ["a", "b"]
    assert saved.json()["data"]["body_ref"]["type_id"] == f"project-{project}"
    assert (tmp_path / ".claude/skills/first/SKILL.md").read_text() == text
    before_conflict = (tmp_path / ".claude/skills/second/SKILL.md").read_bytes()
    stale = await client.post(route, json={"expected_revision": revision, "body": "stale"})
    assert stale.status_code == 409, stale.text
    assert stale.json()["data"]["code"] == "stale_document"
    assert (tmp_path / ".claude/skills/second/SKILL.md").read_bytes() == before_conflict


async def test_create_honors_selected_mount_and_refuses_collision(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await project_at(client, tmp_path)
    destination = {"type_id": f"project-{project}", "path": ".agents/skills", "ref_type": "folder", "read_only": False}
    route = f"/api/v1/graph/project/{project}/skill"
    response = await client.post(route, json={"name": "Exact Choice", "description": "test", "destination": destination})
    assert response.status_code == 200, response.text
    row = response.json()["data"]
    target = tmp_path / ".agents/skills/exact_choice/SKILL.md"
    assert target.is_file()
    assert Path(row["asset_ref"]).resolve() == target.parent.resolve()
    assert row["project_id"] == project
    before = target.read_bytes()
    collision = await client.post(route, json={"name": "Exact Choice", "destination": destination})
    assert collision.status_code == 409, collision.text
    assert target.read_bytes() == before


async def test_creation_refuses_readonly_or_escaping_destination(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    project = await project_at(client, tmp_path)
    route = f"/api/v1/graph/project/{project}/skill"
    for path, readonly in ((".agents/skills", True), ("../outside/.agents/skills", False)):
        response = await client.post(route, json={"name": "Denied", "destination": {
            "type_id": f"project-{project}", "path": path, "ref_type": "folder", "read_only": readonly}})
        assert response.status_code == 403, response.text
    assert not (tmp_path / ".agents/skills/denied").exists()


async def test_document_remote_without_conditional_write_refuses_upload(bootstrapped_client, tmp_path, monkeypatch):
    from flow_sdk.actions.fs import fs_actions

    client = bootstrapped_client
    project = await project_at(client, tmp_path)

    class RemoteStorage:
        async def upload(self, *args, **kwargs):
            pytest.fail('Unsupported conditional storage must never upload')

    async def storage_for(request):
        return RemoteStorage()

    monkeypatch.setattr(fs_actions, '_get_storage_for_entity', storage_for)
    response = await client.post(f'/api/v1/graph/project/{project}/fs/document/SKILL.md',
                                 json={'expected_revision': 'prior-revision', 'body': 'changed'})
    assert response.status_code == 501, response.text
    assert response.json()['data']['code'] == 'conditional_write_unsupported'
