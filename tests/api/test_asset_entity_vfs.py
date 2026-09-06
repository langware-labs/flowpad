from pathlib import Path


async def test_git_asset_record_and_fs_use_entity_relative_vfs(bootstrapped_client, tmp_path: Path):
    project_root = tmp_path / "flowpad-os"
    project_response = await bootstrapped_client.post(
        "/api/v1/graph/project",
        json={
            "type": "project",
            "name": "flowpad-os",
            "fs_storage_mount_path": str(project_root),
        },
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["data"]["id"]

    agent_response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project_id}/agent",
        json={"type": "agent", "name": "Q", "title": "QA manager"},
    )
    assert agent_response.status_code == 200, agent_response.text
    agent = agent_response.json()["data"]
    agent_id = agent["id"]
    type_id = f"agent-{agent_id}"

    refs_response = await bootstrapped_client.get(f"/api/v1/graph/agent/{agent_id}/record/refs")
    assert refs_response.status_code == 200, refs_response.text
    assert refs_response.json()["data"] == {
        "record_folder_ref": {
            "path": "/",
            "ref_type": "folder",
            "read_only": False,
            "type_id": type_id,
        },
        "main_ref": {
            "path": "agent.md",
            "ref_type": "file",
            "read_only": False,
            "type_id": type_id,
        },
    }

    # ``asset_ref`` is the asset ROOT (the folder asserted as ``record`` above);
    # the body is its main file, the same ``agent.md`` ``main_ref`` names.
    source_path = Path(agent["asset_ref"]) / "agent.md"
    source = source_path.read_text(encoding="utf-8")
    updated = source.replace("title: QA manager", "title: QA manager — entity VFS")
    write_response = await bootstrapped_client.post(
        f"/api/v1/graph/agent/{agent_id}/fs/write/agent.md",
        json={"content": updated},
    )
    assert write_response.status_code == 200, write_response.text
    assert source_path.read_text(encoding="utf-8") == updated
    assert not (project_root / "agent.md").exists()
