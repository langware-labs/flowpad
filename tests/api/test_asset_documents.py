"""Document and destination contracts through the real graph/FS dispatcher."""
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from tests.unit._project_names import unique_project_name

pytestmark = pytest.mark.asyncio


async def project_at(client, path):
    response = await client.post("/api/v1/graph/project", json={"name": unique_project_name("asset-documents"), "fs_storage_mount_path": str(path)})
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


def _git(cwd, *args):
    import subprocess  # noqa: PLC0415
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=cwd, check=True,
                          capture_output=True, text=True).stdout


async def test_an_unchanged_agent_save_neither_bumps_the_version_nor_commits(bootstrapped_client, tmp_path):
    """Opening the agent page saved the untouched prompt; each save minted "Flowpad: <agent> vN"
    and left the project with unpushed commits. A save with the loaded content is not a change."""
    import json  # noqa: PLC0415

    client = bootstrapped_client
    folder = tmp_path / "agentic-assets" / "agent" / "procurement"
    folder.mkdir(parents=True)
    card = {"type": "agent", "id": mint_uuid(), "name": "Procurement agent", "worker_type": "claude", "version": 2}
    (folder / "agent.json").write_text(json.dumps(card, indent=2) + "\n")
    prompt = "# Procurement agent\n\n## Hard limits\n\n- Never buy.\n- Never ask for card details.\n"
    (folder / "system_prompt.md").write_text(prompt)
    _git(tmp_path, "init", "-q")
    # The product's own commit runs plain git: give the repo an identity (a CI runner has no global one).
    _git(tmp_path, "config", "user.name", "t")
    _git(tmp_path, "config", "user.email", "t@t")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "init")
    project = await project_at(client, tmp_path)
    route = f"/api/v1/graph/project/{project}/fs/document/agentic-assets/agent/procurement/agent.json"
    loaded = (await client.get(route)).json()["data"]
    assert loaded["body"] == prompt
    saved = await client.post(route, json={"expected_revision": loaded["revision"], "body": loaded["body"],
                                           "set_fields": {"name": loaded["fields"]["name"]}})
    assert saved.status_code == 200, saved.text
    assert _git(tmp_path, "rev-list", "--count", "HEAD").strip() == "1"
    assert _git(tmp_path, "status", "--porcelain").strip() == "", _git(tmp_path, "diff")
    assert json.loads((folder / "agent.json").read_text())["version"] == 2
    # The guard is not vacuous: a real body change in the same call does version and commit.
    edited = await client.post(route, json={"expected_revision": saved.json()["data"]["revision"],
                                            "body": prompt + "- Only procurement.\n"})
    assert edited.status_code == 200, edited.text
    assert _git(tmp_path, "rev-list", "--count", "HEAD").strip() == "2"
    assert json.loads((folder / "agent.json").read_text())["version"] == 3
