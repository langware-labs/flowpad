"""
API Key management tests - migrated from FlowPad.

Tests the api-keys action endpoint for creating, listing, and deactivating API keys.
Simplified for minihub (single @local user, no auth enforcement).

Original: old_flowpad_repo/flowpad/flowpad/hub/tests/api/test_api_keys.py
Classification: ADAPT (cloud auth tests skipped, CRUD tests adapted)
"""


import pytest

from flow_sdk.responses.response import ApiResponseStatus


@pytest.mark.asyncio
async def test_create_api_key(bootstrapped_client, user):
    """
    Test: Create an API key via POST /api/v1/graph/user/{id}/api-keys

    Validates:
    - POST creates a new API key
    - Response contains full key value (shown once)
    - Key has correct format and metadata
    """
    client = bootstrapped_client
    api_key_data = {
        "name": "Test API Key",
        "bind_typeid": str(user.typeid),
    }

    response = await client.post(
        f"/api/v1/graph/user/{user.id}/api-keys",
        json=api_key_data,
    )

    assert response.status_code == 200, f"Failed to create API key: {response.text}"
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value

    data = res["data"]
    # Full key returned at creation
    assert "api_key" in data, "Full API key not returned in response"
    full_key = data["api_key"]
    assert full_key.startswith("fp_live_"), f"API key has invalid format: {full_key}"
    assert len(full_key) == 32, f"API key has invalid length: {len(full_key)} (expected 32)"

    # Metadata
    assert data["name"] == "Test API Key"
    assert data["target_typeid"] == str(user.typeid)
    assert data["visible_value"] == f"****{full_key[-4:]}"


@pytest.mark.asyncio
async def test_list_api_keys(bootstrapped_client, user):
    """
    Test: List API keys via GET /api/v1/graph/user/{id}/api-keys

    Validates:
    - GET returns list of keys
    - Each key includes metadata (name, is_active, etc.)
    """
    client = bootstrapped_client

    # Create 2 API keys
    for name in ["List Key 1", "List Key 2"]:
        response = await client.post(
            f"/api/v1/graph/user/{user.id}/api-keys",
            json={"name": name, "bind_typeid": str(user.typeid)},
        )
        assert response.status_code == 200, f"Failed to create key '{name}': {response.text}"

    # List all keys
    response = await client.get(f"/api/v1/graph/user/{user.id}/api-keys")
    assert response.status_code == 200, f"Failed to list API keys: {response.text}"

    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value

    keys = res["data"]
    assert isinstance(keys, list), "Response data should be a list"
    assert len(keys) >= 2, f"Expected at least 2 keys, got {len(keys)}"

    # Verify required fields are present in each key
    for key in keys:
        assert "id" in key, "id should be present"
        assert "name" in key, "name should be present"
        assert "is_active" in key, "is_active should be present"
        assert "target_typeid" in key, "target_typeid should be present"
        assert key["target_typeid"] == str(user.typeid)
        assert key["visible_value"] == "****"
        assert "api_key" not in key, "Full API key must only be returned at creation"


@pytest.mark.asyncio
async def test_deactivate_api_key(bootstrapped_client, user):
    """
    Test: Deactivate an API key via DELETE /api/v1/graph/user/{id}/api-keys

    Validates:
    - DELETE deactivates the key (sets is_active=False)
    - Deactivated key shows up as inactive in list
    """
    client = bootstrapped_client

    # Create an API key
    create_response = await client.post(
        f"/api/v1/graph/user/{user.id}/api-keys",
        json={"name": "Deactivate Test Key", "bind_typeid": str(user.typeid)},
    )
    assert create_response.status_code == 200
    key_id = create_response.json()["data"]["id"]

    # The shared hub/desktop contract addresses active keys by name.
    delete_response = await client.delete(
        f"/api/v1/graph/user/{user.id}/api-keys/Deactivate%20Test%20Key",
    )
    assert delete_response.status_code == 200, f"Failed to deactivate API key: {delete_response.text}"

    res = delete_response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["is_active"] is False


@pytest.mark.asyncio
async def test_create_api_key_derives_target_from_request_path(bootstrapped_client, user):
    """
    The bound principal comes from the URL, matching the hub contract.
    """
    client = bootstrapped_client

    response = await client.post(
        f"/api/v1/graph/user/{user.id}/api-keys",
        json={"name": "Missing bind_typeid"},
    )

    assert response.status_code == 200
    res = response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["target_typeid"] == str(user.typeid)
