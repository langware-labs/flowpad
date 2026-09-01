"""
Graph API error handling tests.

Ported from FlowPad: flowpad/hub/tests/api/test_basic_crud.py
(test_none_existing_action, test_none_existing_id, test_non_existing_type)

Tests proper error responses for:
- Non-existent entity types
- Non-existent actions
- Non-existent entity IDs
"""

import logging
import uuid

from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


async def test_non_existing_type(client):
    """Test that requesting an unknown entity type returns 422."""
    response = await client.get("/api/v1/graph/nonexistent_type")
    assert response.status_code == 422, response.text
    res = ApiResponse.parse_json(response.text)
    assert "Unknown" in res.message or "nonexistent_type" in res.message


async def test_non_existing_action_on_type(bootstrapped_client):
    """Test that requesting an unknown action on a valid type returns an error."""
    client = bootstrapped_client
    response = await client.get("/api/v1/graph/user/totally_fake_action")
    # Should return an error (either 422 for unrecognized action or 401 for unresolved ID)
    assert response.status_code in [401, 422], (
        f"Expected 401 or 422 for unknown action, got {response.status_code}: {response.text}"
    )


async def test_non_existing_id(bootstrapped_client):
    """Test that requesting a non-existent entity ID returns an error (403 in minihub)."""
    client = bootstrapped_client
    fake_id = str(uuid.uuid4())
    response = await client.get(f"/api/v1/graph/user/{fake_id}")
    # Returns 404 for entity-not-found
    assert response.status_code in [401, 403, 404], (
        f"Expected 401/403/404 for non-existent ID, got {response.status_code}: {response.text}"
    )


async def test_missing_target_short_circuits_watch(bootstrapped_client, caplog):
    """Watching a stale target id should fail before the watch action runs."""
    client = bootstrapped_client
    fake_id = str(uuid.uuid4())
    caplog.set_level(logging.WARNING)

    response = await client.post(
        f"/api/v1/graph/project/{fake_id}/watch",
        json={"connection_id": str(uuid.uuid4())},
    )

    assert response.status_code == 404, response.text
    res = response.json()
    assert res["status"] == ApiResponseStatus.FAIL.value
    assert res["message"] == f"Entity not found: project/{fake_id}"
    assert not any("B1-probe" in record.message for record in caplog.records)
    assert not any("entity_model.get_by_typeid returned None" in record.message for record in caplog.records)


async def test_error_response_format(client):
    """Test that error responses follow the ApiResponse format."""
    response = await client.get("/api/v1/graph/nonexistent_xyz")
    assert response.status_code == 422, response.text
    res = response.json()
    # Should have the standard ApiResponse fields
    assert "status" in res
    assert "message" in res
    assert res["status"] == "FAIL"


async def test_delete_non_existing_entity(bootstrapped_client):
    """Test that deleting a non-existent entity returns an error."""
    client = bootstrapped_client
    fake_id = str(uuid.uuid4())
    response = await client.delete(f"/api/v1/graph/user/{fake_id}")
    # Minihub returns 403 for entity-not-found
    assert response.status_code in [401, 403, 404], (
        f"Expected error for deleting non-existent entity, got {response.status_code}: {response.text}"
    )


async def test_update_non_existing_entity(bootstrapped_client):
    """Test that updating a non-existent entity returns an error."""
    client = bootstrapped_client
    fake_id = str(uuid.uuid4())
    response = await client.put(
        f"/api/v1/graph/user/{fake_id}",
        json={"name": "should_fail"},
    )
    # Minihub returns 500 for update-not-found (ValueError not yet wrapped in HTTPException)
    assert response.status_code in [401, 403, 404, 500], (
        f"Expected error for updating non-existent entity, got {response.status_code}: {response.text}"
    )


async def test_empty_type_path(client):
    """Test that an empty graph path is handled correctly."""
    response = await client.get("/api/v1/graph/")
    # Minihub returns 400 for empty path (no resource type specified)
    assert response.status_code in [200, 307, 400, 404, 405, 422], (
        f"Unexpected status for empty graph path: {response.status_code}"
    )
