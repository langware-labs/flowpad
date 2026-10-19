"""
Workspace entity CRUD API tests.

Ported from FlowPad: flowpad/hub/tests/api/test_get_related_workspace.py
and flowpad/hub/tests/api/test_scope.py (single-user subset).

Tests workspace creation, retrieval, update, deletion, and
creating entities under a workspace scope.
"""

import json

from flow_sdk.builtin.workspace import Workspace
from flow_sdk.responses.response import ApiResponseStatus

# --- Helpers ---

async def create_workspace(client, name="test_ws") -> dict:
    """Create a workspace and return the response data."""
    ws = Workspace(name=name)
    response = await client.post(
        "/api/v1/graph/workspace",
        json=json.loads(ws.model_dump_json(exclude_none=True)),
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    return res["data"]


# --- Tests ---


async def test_create_workspace(bootstrapped_client):
    """Test creating a workspace entity."""
    client = bootstrapped_client
    ws_data = await create_workspace(client, "My Workspace")
    assert ws_data["name"] == "My Workspace"
    assert ws_data["id"] is not None
    assert ws_data["type"] == "workspace"


async def test_list_workspaces(bootstrapped_client):
    """Test listing all workspace entities (includes bootstrap workspace)."""
    client = bootstrapped_client
    await create_workspace(client, "WS Alpha")
    await create_workspace(client, "WS Beta")

    response = await client.get("/api/v1/graph/workspace")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    workspaces = res["data"]
    assert isinstance(workspaces, list)
    names = [w["name"] for w in workspaces]
    assert "WS Alpha" in names
    assert "WS Beta" in names


async def test_get_workspace_by_id(bootstrapped_client):
    """Test retrieving a specific workspace by ID."""
    client = bootstrapped_client
    ws_data = await create_workspace(client, "Specific WS")
    ws_id = ws_data["id"]

    response = await client.get(f"/api/v1/graph/workspace/{ws_id}")
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["id"] == ws_id
    assert res["data"]["name"] == "Specific WS"


async def test_update_workspace(bootstrapped_client):
    """Test updating a workspace name."""
    client = bootstrapped_client
    ws_data = await create_workspace(client, "Original WS Name")
    ws_id = ws_data["id"]

    ws_data["name"] = "Updated WS Name"
    response = await client.put(
        f"/api/v1/graph/workspace/{ws_id}",
        json=ws_data,
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["name"] == "Updated WS Name"


async def test_patch_workspace(bootstrapped_client):
    """Test patching a workspace field."""
    client = bootstrapped_client
    ws_data = await create_workspace(client, "Patch WS")
    ws_id = ws_data["id"]

    response = await client.patch(
        f"/api/v1/graph/workspace/{ws_id}",
        json={"name": "Patched WS"},
    )
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["data"]["name"] == "Patched WS"


async def test_delete_workspace(bootstrapped_client):
    """Test deleting a workspace entity."""
    client = bootstrapped_client
    ws_data = await create_workspace(client, "Delete Me WS")
    ws_id = ws_data["id"]

    # Delete
    response = await client.delete(f"/api/v1/graph/workspace/{ws_id}")
    assert response.status_code == 200, response.text

    # Verify not in listing
    response = await client.get("/api/v1/graph/workspace")
    assert response.status_code == 200, response.text
    res = response.json()
    remaining = [w for w in (res["data"] or []) if w.get("id") == ws_id]
    assert len(remaining) == 0, f"Workspace {ws_id} still exists after delete"


async def test_workspace_created_by_local_user(bootstrapped_client, user):
    """Test that created_by is set to the @local user."""
    client = bootstrapped_client
    ws_data = await create_workspace(client, "Authored WS")
    assert ws_data["created_by"] == user.id
    assert ws_data["updated_by"] == user.id
