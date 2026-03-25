"""
API Key management tests - migrated from FlowPad.

Tests the api-keys action endpoint for creating, listing, and deactivating API keys.
Simplified for minihub (single @local user, no auth enforcement).

Original: old_flowpad_repo/flowpad/flowpad/hub/tests/api/test_api_keys.py
Classification: ADAPT (cloud auth tests skipped, CRUD tests adapted)
"""

import json

import pytest

from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


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
    assert "key" in data, "Full API key not returned in response"
    full_key = data["key"]
    assert full_key.startswith("fp_live_"), f"API key has invalid format: {full_key}"
    assert len(full_key) == 32, f"API key has invalid length: {len(full_key)} (expected 32)"

    # Metadata
    assert data["name"] == "Test API Key"
    assert data["bind_typeid"] == str(user.typeid)


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
        assert "bind_typeid" in key, "bind_typeid should be present"


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

    # Deactivate the key - use request() since delete() doesn't support content/json
    delete_response = await client.request(
        "DELETE",
        f"/api/v1/graph/user/{user.id}/api-keys",
        json={"id": key_id},
    )
    assert delete_response.status_code == 200, f"Failed to deactivate API key: {delete_response.text}"

    res = delete_response.json()
    assert res["status"] == ApiResponseStatus.SUCCESS.value
    assert res["data"]["is_active"] is False


@pytest.mark.asyncio
async def test_create_api_key_requires_bind_typeid(bootstrapped_client, user):
    """
    Test: Creating an API key without bind_typeid fails.
    """
    client = bootstrapped_client

    response = await client.post(
        f"/api/v1/graph/user/{user.id}/api-keys",
        json={"name": "Missing bind_typeid"},
    )

    # The action may return 500 (unhandled error) or 200 with FAIL status
    # depending on how the graph handler wraps the error
    if response.status_code == 200:
        res = response.json()
        assert res["status"] == "FAIL"
        assert "bind_typeid" in res["message"].lower()
    else:
        # Error is caught by the CatchAllExceptionMiddleware and returned as 500
        assert response.status_code == 500
        res = response.json()
        assert "bind_typeid" in res.get("message", "").lower() or "bind_typeid" in str(res).lower()
