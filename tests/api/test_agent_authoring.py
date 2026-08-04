"""Ordinary Agent authoring through the generic project-scoped graph API."""

import asyncio
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import is_valid_entity_id, mint_uuid
from flow_sdk.builtin.agent import Agent
from flow_sdk.capsules import AssetCapsule
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter
from flow_sdk.fs_store.fs_record import AssetPathCollisionError
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.agent import extract_agent

pytestmark = pytest.mark.asyncio


async def _create_project(client, name: str, mount: Path) -> dict:
    response = await client.post(
        "/api/v1/graph/project",
        json={"type": "project", "name": name, "fs_storage_mount_path": str(mount)},
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


async def test_project_agent_collision_preserves_the_first_bundle(bootstrapped_client, tmp_path):
    client = bootstrapped_client
    first_root, second_root = tmp_path / "first", tmp_path / "second"
    first = await _create_project(client, "agent-authoring-first", first_root)
    second = await _create_project(client, "agent-authoring-second", second_root)
    payload = {
        "type": "agent",
        "name": "Q",
        "title": "QA manager",
        "avatar": "./avatar.png",
        "system_prompt": "Run QA when asked.",
    }

    created_response = await client.post(f"/api/v1/graph/project/{first['id']}/agent", json=payload)
    assert created_response.status_code == 200, created_response.text
    created = created_response.json()["data"]
    assert is_valid_entity_id(created["id"])
    assert created["project_id"] == first["id"]

    agent_md = first_root / "agentic-assets" / "agent" / "q" / "agent.md"
    original_bytes = agent_md.read_bytes()
    original_identity = AssetCapsule.from_path(agent_md).read("identity")
    assert original_identity is not None
    assert original_identity.data["id"] == created["id"]

    [disk_record] = extract_agent(FSRef(agent_md), created["id"])
    assert (disk_record.name, disk_record.title, disk_record.avatar) == (
        "Q",
        "QA manager",
        "./avatar.png",
    )

    collision = await client.post(
        f"/api/v1/graph/project/{first['id']}/agent",
        json={**payload, "name": "q", "title": "Different"},
    )
    assert collision.status_code == 409, collision.text
    assert "already exists in this scope" in collision.text
    assert agent_md.read_bytes() == original_bytes
    assert AssetCapsule.from_path(agent_md).read("identity") == original_identity
    assert (await Agent.get_by_id(created["id"])).title == "QA manager"

    rows = await Agent.get_all(QueryFilter(match=ExpressionNode(project_id=first["id"])))
    assert [row.id for row in rows if row.asset_ref == str(agent_md)] == [created["id"]]

    other_scope = await client.post(f"/api/v1/graph/project/{second['id']}/agent", json=payload)
    assert other_scope.status_code == 200, other_scope.text
    assert other_scope.json()["data"]["id"] != created["id"]


async def test_schema_invalid_agent_remains_bad_request(bootstrapped_client, tmp_path):
    project = await _create_project(bootstrapped_client, "agent-authoring-invalid", tmp_path / "invalid")
    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project['id']}/agent",
        json={"type": "agent", "name": "invalid", "max_turns": "not-an-integer"},
    )
    assert response.status_code == 400, response.text


async def test_create_ignores_caller_asset_ref_and_uses_project_placement(bootstrapped_client, tmp_path):
    project_root = tmp_path / "project"
    project = await _create_project(bootstrapped_client, "agent-authoring-contained", project_root)
    outside = tmp_path / "caller-selected" / "agent.md"

    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project['id']}/agent",
        json={
            "type": "agent",
            "name": "Contained",
            "asset_ref": str(outside),
            "project_id": mint_uuid(),
            "scope": "user",
        },
    )

    assert response.status_code == 200, response.text
    expected = project_root / "agentic-assets" / "agent" / "contained" / "agent.md"
    assert response.json()["data"]["asset_ref"] == str(expected)
    assert response.json()["data"]["project_id"] == project["id"]
    assert response.json()["data"]["scope"] == "project"
    assert expected.is_file()
    assert not outside.exists()


async def test_create_rejects_a_symlinked_placement_escape(bootstrapped_client, tmp_path):
    project_root = tmp_path / "symlink-project"
    project = await _create_project(bootstrapped_client, "agent-authoring-symlink", project_root)
    outside = tmp_path / "outside"
    outside.mkdir()
    (project_root / "agentic-assets").symlink_to(outside, target_is_directory=True)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/project/{project['id']}/agent",
        json={"type": "agent", "name": "Q"},
    )

    assert response.status_code == 400, response.text
    assert "escapes its scope root" in response.text
    assert not (outside / "agent" / "q" / "agent.md").exists()
    assert await Agent.get_one({"name": "Q", "project_id": project["id"]}) is None


async def test_simultaneous_same_slug_creates_have_one_winner(bootstrapped_client, tmp_path):
    project = await _create_project(bootstrapped_client, "agent-authoring-race", tmp_path / "race")
    url = f"/api/v1/graph/project/{project['id']}/agent"

    responses = await asyncio.gather(
        bootstrapped_client.post(url, json={"type": "agent", "name": "Race Agent"}),
        bootstrapped_client.post(url, json={"type": "agent", "name": "race agent"}),
    )

    assert sorted(response.status_code for response in responses) == [200, 409]
    carrier = tmp_path / "race" / "agentic-assets" / "agent" / "race_agent" / "agent.md"
    winner = next(response.json()["data"] for response in responses if response.status_code == 200)
    assert AssetCapsule.from_path(carrier).read("identity").data["id"] == winner["id"]
    rows = await Agent.get_all(QueryFilter(match=ExpressionNode(project_id=project["id"])))
    assert [row.id for row in rows if row.asset_ref == str(carrier)] == [winner["id"]]


async def test_prepared_fresh_asset_rechecks_collision_at_save(bootstrapped_client, tmp_path):
    """A caller-populated asset_ref must not bypass the guarded create seam."""
    agent = Agent(name="Q")
    await agent._prepare_for_storage(tmp_path)
    carrier = tmp_path / "agentic-assets" / "agent" / "q" / "agent.md"
    carrier.parent.mkdir(parents=True, exist_ok=True)
    original = b"existing authored bundle\n"
    carrier.write_bytes(original)

    with pytest.raises(AssetPathCollisionError, match="already exists in this scope"):
        await agent.save()

    assert carrier.read_bytes() == original
    assert await Agent.get_by_id(agent.id) is None
