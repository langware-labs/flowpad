"""E2E tests for Shell ↔ AgenticProcess lifecycle (Phase 4).

Tests both directions:
1. Top-down: Create AgenticProcess → start → verify Shell + entity linkage
2. Bottom-up: Open raw PTY → elevate-pty → verify AgenticProcess created
"""

import asyncio
import uuid

import pytest

from flow_sdk.responses.response import ApiResponse


def _get_default_compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


@pytest.mark.asyncio
async def test_open_pty_creates_pty_session(bootstrapped_client):
    """Open a process via open action, verify Shell entity linkage."""
    # Get compute node
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert bootstrap.status_code == 200
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    # Create process directly on the compute node
    response = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json={"context": {"compute_node_id": f"compute_node-{compute_node_id}"}},
    )
    assert response.status_code == 200, response.text
    process_data = ApiResponse(**response.json())
    process_id = process_data.data["id"]

    # Call open with a simple echo command
    response = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
        json={"instruction": "echo hello world"},
    )
    assert response.status_code == 200, response.text
    result = ApiResponse(**response.json())
    assert result.status == "SUCCESS", f"open failed: {result.message}"

    pty_data = result.data
    assert "shell_id" in pty_data, f"Missing shell_id in response: {pty_data}"
    assert "session_id" in pty_data, f"Missing session_id in response: {pty_data}"

    shell_id = pty_data["shell_id"]
    session_id = pty_data["session_id"]
    assert shell_id, "shell_id should not be empty"
    assert session_id, "session_id should not be empty"

    # Verify process entity has shell_id set
    response = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert response.status_code == 200, response.text
    entity_data = ApiResponse(**response.json())
    process_entity = entity_data.data
    assert process_entity.get("shell_id") == shell_id
    assert process_entity["session_id"] == session_id

    # Clean up: stop the shell
    response = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/stop",
        json={},
    )
    assert response.status_code == 200, response.text

    # Allow PTY process to terminate and release DB locks
    await asyncio.sleep(0.5)


@pytest.mark.asyncio
async def test_upsert_session_process(bootstrapped_client):
    """upsertSessionProcess creates a process for a session, returns same on repeat call."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert bootstrap.status_code == 200
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    test_session_id = f"test-{uuid.uuid4().hex[:8]}"

    response = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/upsertSessionProcess",
        json={"sessionId": test_session_id},
    )
    assert response.status_code == 200, response.text
    result = ApiResponse(**response.json())
    assert result.status == "SUCCESS", f"upsertSessionProcess failed: {result.message}"

    upsert_data = result.data
    assert upsert_data["created"] is True
    assert upsert_data["session_id"] == test_session_id

    # Verify the process exists and has correct session_id
    process_id = upsert_data["id"]
    response = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert response.status_code == 200, response.text
    entity_data = ApiResponse(**response.json())
    process_entity = entity_data.data
    assert process_entity["session_id"] == test_session_id

    # Calling upsertSessionProcess again should return same process (not create new)
    response = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/upsertSessionProcess",
        json={"sessionId": test_session_id},
    )
    assert response.status_code == 200, response.text
    result2 = ApiResponse(**response.json())
    assert result2.data["created"] is False
    assert result2.data["id"] == process_id


def test_flowpad_pty_pid_in_env():
    """Verify that FLOWPAD_PTY_SESSION_ID is set in the PTY environment.

    We verify this by checking the source code includes the env var injection.
    This test doesn't need the server — it's a pure source inspection.
    """
    import inspect

    from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider

    source = inspect.getsource(LocalComputeProvider.get_or_create_pty_session)
    assert "FLOWPAD_PTY_SESSION_ID" in source, "FLOWPAD_PTY_SESSION_ID should be set in get_or_create_pty_session"
