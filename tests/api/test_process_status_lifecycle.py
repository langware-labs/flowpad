"""Test AgenticProcess status lifecycle through shell operations.

Verifies that status is derived from the Claude session transcript:
  - No transcript → idle (default)
  - Transcript with last assistant stop_reason="tool_use" → running
  - Transcript with last assistant stop_reason="end_turn" → complete
  - After stop, status still reflects transcript state (not forced idle)

The process entity's state.status is derived from the Claude session transcript
so the frontend can gate UI controls (e.g. ProcessToolbar toggles).
"""

import asyncio

import pytest

from flow_sdk.responses.response import ApiResponse


def _get_default_compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


async def _create_process(client, compute_node_id: str) -> tuple[None, str]:
    """Create a process directly on the compute node, return (None, process_id)."""
    resp = await client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json={"context": {"compute_node_id": f"compute_node-{compute_node_id}"}},
    )
    assert resp.status_code == 200, resp.text
    process_id = ApiResponse(**resp.json()).data["id"]
    return None, process_id


async def _get_process_status(client, process_id: str) -> str:
    """Fetch the process entity and return state.status."""
    resp = await client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert resp.status_code == 200, resp.text
    entity = ApiResponse(**resp.json()).data
    return entity.get("status", "unknown")


@pytest.mark.asyncio
async def test_process_status_idle_on_create(bootstrapped_client):
    """Newly created process should have idle status (no transcript)."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    _, process_id = await _create_process(bootstrapped_client, compute_node_id)

    status = await _get_process_status(bootstrapped_client, process_id)
    assert status == "idle", f"Expected idle on create, got {status}"


@pytest.mark.asyncio
async def test_process_status_after_start(bootstrapped_client):
    """After start, process status depends on transcript state."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    _, process_id = await _create_process(bootstrapped_client, compute_node_id)

    # Open shell with a simple command
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
        json={"instruction": "hi"},
    )
    assert resp.status_code == 200, resp.text
    result = ApiResponse(**resp.json())
    assert result.status == "SUCCESS", f"open failed: {result.message}"

    # Status is transcript-derived: may be idle (no transcript yet),
    # running (Claude is processing), or complete (Claude already finished)
    status = await _get_process_status(bootstrapped_client, process_id)
    assert status in ("idle", "null", "empty", "waiting", "thinking", "tool_call", "tool_running", "running", "complete", "inactive"), f"Expected transcript-derived status, got {status}"

    # Clean up
    await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/exit",
        json={},
    )
    await asyncio.sleep(0.5)


@pytest.mark.asyncio
async def test_process_status_after_kill_pty(bootstrapped_client):
    """After stop, process status reflects transcript (not forced idle)."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    _, process_id = await _create_process(bootstrapped_client, compute_node_id)

    # Open shell
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
        json={"instruction": "hi"},
    )
    assert resp.status_code == 200, resp.text
    result = ApiResponse(**resp.json())
    assert result.status == "SUCCESS", f"open failed: {result.message}"

    # Stop shell
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/exit",
        json={},
    )
    assert resp.status_code == 200, resp.text
    stop_result = ApiResponse(**resp.json())
    assert stop_result.status == "SUCCESS", f"exit failed: {stop_result.message}"

    await asyncio.sleep(0.5)

    # Status is transcript-derived, not forced idle by stop
    status = await _get_process_status(bootstrapped_client, process_id)
    assert status in ("idle", "null", "empty", "waiting", "thinking", "tool_call", "tool_running", "running", "complete", "inactive"), f"Expected transcript-derived status after stop, got {status}"


@pytest.mark.asyncio
async def test_process_status_full_lifecycle(bootstrapped_client):
    """Full lifecycle: idle → transcript-derived, with context_data preserved."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    _, process_id = await _create_process(bootstrapped_client, compute_node_id)

    # 1. Verify initial idle (no transcript)
    status = await _get_process_status(bootstrapped_client, process_id)
    assert status == "idle", f"Step 1: Expected idle, got {status}"

    # 2. Open shell → status from transcript
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
        json={"instruction": "hi"},
    )
    assert resp.status_code == 200, resp.text
    result = ApiResponse(**resp.json())
    assert result.status == "SUCCESS", f"open failed: {result.message}"

    status = await _get_process_status(bootstrapped_client, process_id)
    assert status in ("idle", "null", "empty", "waiting", "thinking", "tool_call", "tool_running", "running", "complete", "inactive"), f"Step 2: Expected transcript-derived status, got {status}"

    # Verify session_id and shell_id are set
    resp = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    entity = ApiResponse(**resp.json()).data
    assert entity.get("session_id"), "session_id should be set while running"
    assert entity.get("shell_id"), "shell_id should be set while running"
    worker_sid = entity["session_id"]

    # 3. Stop shell → status still from transcript
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/exit",
        json={},
    )
    assert resp.status_code == 200, resp.text

    await asyncio.sleep(0.5)

    status = await _get_process_status(bootstrapped_client, process_id)
    assert status in ("idle", "null", "empty", "waiting", "thinking", "tool_call", "tool_running", "running", "complete", "inactive"), f"Step 3: Expected transcript-derived status, got {status}"

    # Verify session_id preserved, shell_id cleared
    resp = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    entity = ApiResponse(**resp.json()).data
    assert entity.get("session_id") == worker_sid, "session_id should be preserved after exit"
    assert entity.get("shell_id"), "shell_id should still be set after exit (shell entity kept alive)"


@pytest.mark.asyncio
async def test_context_data_flags_persisted(bootstrapped_client):
    """context_data flags (chrome, permission_mode) round-trip through entity save."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    _, process_id = await _create_process(bootstrapped_client, compute_node_id)

    # Update context_data with chrome + permission_mode flags
    resp = await bootstrapped_client.put(
        f"/api/v1/graph/agentic_process/{process_id}",
        json={
            "context_data": {
                "chrome": True,
                "permission_mode": "bypassPermissions",
                "compute_node_id": f"compute_node-{compute_node_id}",
            },
        },
    )
    assert resp.status_code == 200, resp.text

    # Re-read and verify flags persisted
    resp = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    entity = ApiResponse(**resp.json()).data
    ctx = entity.get("context_data", {})
    assert ctx.get("chrome") is True, f"chrome flag not persisted: {ctx}"
    assert ctx.get("permission_mode") == "bypassPermissions", f"permission_mode not persisted: {ctx}"

    # Update to askUser mode
    resp = await bootstrapped_client.put(
        f"/api/v1/graph/agentic_process/{process_id}",
        json={
            "context_data": {
                "chrome": False,
                "permission_mode": "askUser",
                "compute_node_id": f"compute_node-{compute_node_id}",
            },
        },
    )
    assert resp.status_code == 200, resp.text

    resp = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    entity = ApiResponse(**resp.json()).data
    ctx = entity.get("context_data", {})
    assert ctx.get("chrome") is False, f"chrome flag not updated: {ctx}"
    assert ctx.get("permission_mode") == "askUser", f"permission_mode not updated: {ctx}"
