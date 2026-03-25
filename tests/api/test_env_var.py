"""
Environment variable CRUD tests - migrated from FlowPad.

Tests the env-var action endpoint for creating, reading, updating, and deleting
environment variables on entities (using the @local agent from bootstrap).

Original: old_flowpad_repo/flowpad/flowpad/hub/tests/api/test_env_var.py
Classification: PARTIAL
- Ported: Plain env var CRUD tests (create, read, update, delete, validation)
- Skipped: Confidential env var tests (require SOD store, alice_client/alice_user)
- Skipped: Flow execution tests (test_api_key -- requires Flow entities)
- Skipped: Masking table test (requires env-var/table sub-route with complex fixtures)
"""

import uuid

import pytest

from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


def _unique(prefix: str) -> str:
    """Return a unique env-var name to avoid collisions with stale DB data."""
    return f"{prefix}_{uuid.uuid4().hex[:8].upper()}"


async def _get_agent_id(client) -> str:
    """Get the @local agent ID from bootstrap entities."""
    response = await client.get("/api/v1/graph/agent")
    assert response.status_code == 200, response.text
    agents = response.json()["data"]
    assert len(agents) >= 1, "No agents found after bootstrap"
    return agents[0]["id"]


async def _get_agent_typeid(client) -> str:
    """Get the @local agent typeid string for URL building."""
    agent_id = await _get_agent_id(client)
    return agent_id


@pytest.mark.asyncio
async def test_create_env_var_plain(bootstrapped_client):
    """Test creating a plain (non-confidential) env var via API."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    var_name = _unique("APP_NAME")
    env_var_data = {
        "name": var_name,
        "var_type": "plain",
        "value": "MyAwesomeApp",
        "description": "Application name",
    }

    response = await client.post(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json=env_var_data,
    )

    assert response.status_code == 200, f"Failed to create env var: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value

    data = res["data"]
    assert data["name"] == var_name
    assert data["var_type"] == "plain"
    assert data["description"] == "Application name"
    # For plain vars, visible_value should contain the full value
    assert data["visible_value"] == "MyAwesomeApp"


@pytest.mark.asyncio
async def test_read_env_var_plain(bootstrapped_client):
    """Test reading a plain env var via API returns full value in visible_value."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    # Create a plain env var
    env_var_data = {
        "name": "DATABASE_NAME",
        "var_type": "plain",
        "value": "production_db",
        "description": "Database name",
    }

    await client.post(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json=env_var_data,
    )

    # Get the specific env var
    response = await client.get(f"/api/v1/graph/agent/{agent_id}/env-var/DATABASE_NAME")

    assert response.status_code == 200, f"Failed to get env var: {response.text}"
    data = response.json()["data"]
    assert data["name"] == "DATABASE_NAME"
    assert data["var_type"] == "plain"
    assert data["description"] == "Database name"
    assert data["visible_value"] == "production_db"


@pytest.mark.asyncio
async def test_get_env_vars_list(bootstrapped_client):
    """Test listing env vars for an entity."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    # Create a test env var
    env_var_data = {
        "name": "LIST_TEST_VAR",
        "var_type": "plain",
        "value": "list_test_value",
        "description": "List test description",
    }
    await client.post(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json=env_var_data,
    )

    # Get list of env vars
    response = await client.get(f"/api/v1/graph/agent/{agent_id}/env-var")
    assert response.status_code == 200
    data = response.json()
    env_vars = data["data"]
    assert isinstance(env_vars, list)

    # Find our created var
    found = next((ev for ev in env_vars if ev["name"] == "LIST_TEST_VAR"), None)
    assert found is not None, "Created env var not found in list"
    assert found["var_type"] == "plain"
    assert found["description"] == "List test description"
    assert found["visible_value"] == "list_test_value"


@pytest.mark.asyncio
async def test_get_env_vars_list_empty(bootstrapped_client):
    """Test listing env vars for an entity with no env vars returns empty list."""
    client = bootstrapped_client

    # Create a new workspace (which will have no env vars)
    from flow_sdk.builtin.workspace import Workspace

    ws = Workspace(name="empty_env_vars_test")
    response = await client.post(
        "/api/v1/graph/workspace",
        json={"name": "empty_env_vars_test", "type": "workspace"},
    )
    assert response.status_code == 200
    ws_id = response.json()["data"]["id"]

    # Get list of env vars (should be empty)
    response = await client.get(f"/api/v1/graph/workspace/{ws_id}/env-var")
    assert response.status_code == 200
    data = response.json()
    env_vars = data["data"]
    assert len(env_vars) == 0


@pytest.mark.asyncio
async def test_update_env_var_plain(bootstrapped_client):
    """Test updating a plain env var via API."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    # Create a plain env var
    env_var_data = {
        "name": "ENV_MODE",
        "var_type": "plain",
        "value": "development",
        "description": "Environment mode",
    }

    await client.post(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json=env_var_data,
    )

    # Update the env var
    update_data = {
        "value": "production",
        "description": "Updated environment mode",
    }

    response = await client.put(
        f"/api/v1/graph/agent/{agent_id}/env-var/ENV_MODE",
        json=update_data,
    )

    assert response.status_code == 200, f"Failed to update env var: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value

    data = res["data"]
    assert data["name"] == "ENV_MODE"
    assert data["var_type"] == "plain"
    assert data["description"] == "Updated environment mode"
    assert data["visible_value"] == "production"


@pytest.mark.asyncio
async def test_delete_env_var_plain(bootstrapped_client):
    """Test deleting a plain env var via API."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    # Create a plain env var
    env_var_data = {
        "name": "TEMP_VAR",
        "var_type": "plain",
        "value": "temporary_value",
        "description": "Temporary variable",
    }

    await client.post(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json=env_var_data,
    )

    # Verify it exists
    get_response = await client.get(f"/api/v1/graph/agent/{agent_id}/env-var/TEMP_VAR")
    assert get_response.status_code == 200

    # Delete the env var
    delete_response = await client.delete(f"/api/v1/graph/agent/{agent_id}/env-var/TEMP_VAR")
    assert delete_response.status_code == 200

    # Verify it's deleted
    get_after_delete = await client.get(f"/api/v1/graph/agent/{agent_id}/env-var/TEMP_VAR")
    assert get_after_delete.status_code == 404


@pytest.mark.asyncio
async def test_create_env_var_invalid_name(bootstrapped_client):
    """Test creating an env var with invalid name returns 400."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    env_var_data = {
        "name": "invalid-name!",  # Contains invalid characters
        "var_type": "plain",
        "value": "test_value",
        "description": "test description",
    }

    response = await client.post(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json=env_var_data,
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_get_env_var_not_found(bootstrapped_client):
    """Test getting a non-existent env var returns 404."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    response = await client.get(f"/api/v1/graph/agent/{agent_id}/env-var/NON_EXISTENT")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_get_env_var_invalid_name(bootstrapped_client):
    """Test getting env var with invalid name returns 400."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    response = await client.get(f"/api/v1/graph/agent/{agent_id}/env-var/invalid-name!")
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_update_env_var_not_found(bootstrapped_client):
    """Test updating a non-existent env var returns 404."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    update_data = {"value": "new_value", "description": "new description"}
    response = await client.put(
        f"/api/v1/graph/agent/{agent_id}/env-var/NON_EXISTENT",
        json=update_data,
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_update_env_var_missing_fields(bootstrapped_client):
    """Test updating env var without required fields returns 400."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    # Create a test env var first
    await client.post(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json={"name": "UPDATE_MISSING_TEST", "var_type": "plain", "value": "test_value", "description": "test"},
    )

    # Try to update without required fields
    response = await client.put(
        f"/api/v1/graph/agent/{agent_id}/env-var/UPDATE_MISSING_TEST",
        json={},
    )
    assert response.status_code == 400

    # Try to update without subpath (no secret name in URL)
    response_no_subpath = await client.put(
        f"/api/v1/graph/agent/{agent_id}/env-var",
        json={"value": "new_value", "description": "new description"},
    )
    assert response_no_subpath.status_code == 400


@pytest.mark.asyncio
async def test_delete_env_var_not_found(bootstrapped_client):
    """Test deleting a non-existent env var returns 404."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    response = await client.delete(f"/api/v1/graph/agent/{agent_id}/env-var/NON_EXISTENT")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_delete_env_var_invalid_name(bootstrapped_client):
    """Test deleting env var with invalid name returns 400."""
    client = bootstrapped_client
    agent_id = await _get_agent_id(client)

    response = await client.delete(f"/api/v1/graph/agent/{agent_id}/env-var/invalid-name!")
    assert response.status_code == 400
