"""Test AgenticProcess lifecycle status and transcript worker_status separation."""

import asyncio

import pytest

from flow_sdk.responses.response import ApiResponse


# Wire ``status`` values for a live process — the raw lifecycle FSM value is
# emitted verbatim now (turn-in-flight is the separate ``busy`` boolean).
LIVE_WIRE_STATUSES = {"running"}

# Raw ``worker_status`` is nullable on the wire (None = "nothing found yet").
PRE_PROMPT_WORKER_STATUSES = {
    None,
    "idle",
    "initializing",
    "working",
}

TRANSCRIPT_DERIVED_WORKER_STATUSES = (
    *PRE_PROMPT_WORKER_STATUSES,
    "thinking",
    "tool_call",
    "tool_running",
    "complete",
    "inactive",
)


def _get_default_compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


async def _create_process(client, compute_node_id: str) -> tuple[None, str]:
    """Create a process directly on the compute node, return (None, process_id)."""
    resp = await client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/createProcess",
        json={
            "context": {"compute_node_id": f"compute_node-{compute_node_id}"},
            "visible": True,
        },
    )
    assert resp.status_code == 200, resp.text
    process_id = ApiResponse(**resp.json()).data["id"]
    return None, process_id


async def _get_process_entity(client, process_id: str) -> dict:
    """Fetch the full process entity."""
    resp = await client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert resp.status_code == 200, resp.text
    return ApiResponse(**resp.json()).data


async def _get_process_status(client, process_id: str) -> str:
    entity = await _get_process_entity(client, process_id)
    return entity.get("status", "unknown")


@pytest.mark.asyncio
async def test_process_status_running_after_atomic_create(bootstrapped_client):
    """``createProcess`` is atomic: it spawns the linked Shell + PTY before returning,
    so the new process is already RUNNING with an idle worker (no transcript yet)."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    _, process_id = await _create_process(bootstrapped_client, compute_node_id)

    entity = await _get_process_entity(bootstrapped_client, process_id)
    assert entity.get("status") in LIVE_WIRE_STATUSES, f"Expected live wire status (running) after atomic-start, got {entity.get('status')}"
    # Worker is transcript-derived; pre-prompt it can be idle/initializing/waiting.
    assert entity.get("worker_status") in PRE_PROMPT_WORKER_STATUSES, (
        f"Expected pre-prompt worker_status, got {entity.get('worker_status')}"
    )


@pytest.mark.asyncio
async def test_process_status_after_start(bootstrapped_client):
    """After start, lifecycle status is LIVE while worker_status stays transcript-derived."""
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

    entity = await _get_process_entity(bootstrapped_client, process_id)
    assert entity.get("status") in LIVE_WIRE_STATUSES, f"Expected live wire status (running) after open, got {entity.get('status')}"
    assert entity.get("worker_status") in TRANSCRIPT_DERIVED_WORKER_STATUSES, (
        f"Expected transcript-derived worker_status, got {entity.get('worker_status')}"
    )

    # Clean up
    await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/exit",
        json={},
    )
    await asyncio.sleep(0.5)


@pytest.mark.asyncio
async def test_process_status_after_kill_pty(bootstrapped_client):
    """After exit, lifecycle status becomes STOPPED."""
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

    entity = await _get_process_entity(bootstrapped_client, process_id)
    assert entity.get("status") == "stopped", f"Expected stopped after exit, got {entity.get('status')}"


@pytest.mark.asyncio
async def test_process_status_full_lifecycle(bootstrapped_client):
    """Full lifecycle: createProcess (atomic) -> running -> open (idempotent) -> stopped.

    ``createProcess`` now spawns the linked Shell + PTY before returning, so the
    process is RUNNING from step 1; ``/open`` is the idempotent reattach path.
    """
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    _, process_id = await _create_process(bootstrapped_client, compute_node_id)

    entity = await _get_process_entity(bootstrapped_client, process_id)
    assert entity.get("status") in LIVE_WIRE_STATUSES, f"Step 1: Expected live wire status (running) after atomic-start, got {entity.get('status')}"
    assert entity.get("worker_status") in PRE_PROMPT_WORKER_STATUSES, (
        f"Step 1: Expected pre-prompt worker_status, got {entity.get('worker_status')}"
    )

    # 2. Open shell → idempotent reattach; lifecycle stays running.
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
        json={"instruction": "hi"},
    )
    assert resp.status_code == 200, resp.text
    result = ApiResponse(**resp.json())
    assert result.status == "SUCCESS", f"open failed: {result.message}"

    entity = await _get_process_entity(bootstrapped_client, process_id)
    assert entity.get("status") in LIVE_WIRE_STATUSES, f"Step 2: Expected live wire status (running), got {entity.get('status')}"
    assert entity.get("worker_status") in TRANSCRIPT_DERIVED_WORKER_STATUSES, (
        f"Step 2: Expected transcript-derived worker_status, got {entity.get('worker_status')}"
    )

    # Verify session_id and shell_id are set
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

    entity = await _get_process_entity(bootstrapped_client, process_id)
    assert entity.get("status") == "stopped", f"Step 3: Expected stopped after exit, got {entity.get('status')}"

    # Verify session_id preserved and shell_id retained for shell reuse
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
