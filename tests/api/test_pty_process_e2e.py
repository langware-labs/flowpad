"""E2E tests for Shell ↔ AgenticProcess lifecycle (Phase 4).

Tests both directions:
1. Top-down: Create AgenticProcess → start → verify Shell + entity linkage
2. Bottom-up: Open raw PTY → elevate-pty → verify AgenticProcess created
"""

import asyncio
import json
import uuid
from pathlib import Path

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
        json={
            "context": {"compute_node_id": f"compute_node-{compute_node_id}"},
            "visible": True,
        },
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

    # Clean up: exit the shell (shell entity kept alive, status=idle)
    response = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/exit",
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


@pytest.mark.asyncio
async def test_upsert_session_process_heals_existing_workdir(
    bootstrapped_client,
    tmp_path: Path,
):
    """Existing session processes adopt the history cwd on a later upsert."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    assert bootstrap.status_code == 200
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    test_session_id = f"test-{uuid.uuid4().hex[:8]}"

    first = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/upsertSessionProcess",
        json={"sessionId": test_session_id, "workdir": "/"},
    )
    assert first.status_code == 200, first.text
    created = ApiResponse(**first.json()).data
    process_id = created["id"]
    before = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert before.status_code == 200, before.text
    stale_project_id = ApiResponse(**before.json()).data["project_id"]

    target_cwd = str(tmp_path / "worktree")
    Path(target_cwd).mkdir()
    healed = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/upsertSessionProcess",
        json={
            "sessionId": test_session_id,
            "workdir": target_cwd,
            "projectId": stale_project_id,
        },
    )
    assert healed.status_code == 200, healed.text
    healed_data = ApiResponse(**healed.json()).data
    assert healed_data["created"] is False
    assert healed_data["id"] == process_id

    response = await bootstrapped_client.get(f"/api/v1/graph/agentic_process/{process_id}")
    assert response.status_code == 200, response.text
    process_entity = ApiResponse(**response.json()).data
    assert process_entity["workdir"] == target_cwd
    assert process_entity["context_data"]["workdir"] == target_cwd
    assert process_entity["project_id"] != stale_project_id
    assert process_entity["context_data"]["project_id"] == process_entity["project_id"]

    shell_response = await bootstrapped_client.get(
        f"/api/v1/graph/shell/{process_entity['shell_id']}"
    )
    assert shell_response.status_code == 200, shell_response.text
    shell_entity = ApiResponse(**shell_response.json()).data
    assert shell_entity["workdir"] == target_cwd
    assert shell_entity["project_id"] == process_entity["project_id"]


def _write_fake_claude_jsonl(session_id: str, cwd: str) -> Path:
    """Drop a minimal Claude transcript under the test sandbox claude_projects_dir.

    Mirrors `tests/api/test_agentic_process_resume_after_restart._make_fake_jsonl`
    but parameterizes the cwd so we can verify project_encoded_name flows through.
    Caller is responsible for passing a canonical (realpath-resolved) cwd —
    `Project.recover_by_path` canonicalizes internally and would otherwise return
    a Project with a different encoded name (e.g. `/tmp` → `/private/tmp` on macOS).
    """
    from flow_sdk.instance_settings import get_instance_settings

    encoded = cwd.replace("/", "-")  # mirrors Claude CLI's encoding scheme
    projects_dir = get_instance_settings().claude_projects_dir / encoded
    projects_dir.mkdir(parents=True, exist_ok=True)
    path = projects_dir / f"{session_id}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "user",
                "sessionId": session_id,
                "cwd": cwd,
                "version": "1.0",
                "slug": "find-session-test",
                "timestamp": "2026-05-07T00:00:00.000Z",
                "uuid": str(uuid.uuid4()),
                "message": {"role": "user", "content": "hi"},
            }
        )
        + "\n"
    )
    return path


def _write_fake_codex_rollout(thread_id: str, cwd: str) -> Path:
    """Drop a minimal Codex rollout under the test sandbox codex_sessions_dir."""
    from flow_sdk.instance_settings import get_instance_settings

    day_dir = get_instance_settings().codex_sessions_dir / "2026" / "05" / "07"
    day_dir.mkdir(parents=True, exist_ok=True)
    path = day_dir / f"rollout-2026-05-07T00-00-00-{thread_id}.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "session_meta",
                "payload": {"id": thread_id, "cwd": cwd, "cli_version": "0.1.0"},
            }
        )
        + "\n"
    )
    return path


@pytest.mark.asyncio
async def test_find_session_claude(bootstrapped_client, tmp_path):
    """findSession resolves a Claude session id to its descriptor."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    session_id = str(uuid.uuid4())
    # tmp_path from pytest is already realpath-canonical, so Project.recover_by_path
    # won't re-canonicalize the cwd and produce a different encoded form.
    cwd = str(tmp_path / "find-session-claude-fixture")
    Path(cwd).mkdir(parents=True, exist_ok=True)
    jsonl_path = _write_fake_claude_jsonl(session_id, cwd=cwd)

    try:
        response = await bootstrapped_client.get(
            f"/api/v1/graph/compute_node/{compute_node_id}/findSession",
            params={"session_id": session_id},
        )
        assert response.status_code == 200, response.text
        result = ApiResponse(**response.json())
        assert result.status == "SUCCESS", result.message

        data = result.data
        assert data["session_id"] == session_id
        assert data["worker_type"] == "claude"
        assert data["transcript_path"] == str(jsonl_path)
        assert data["project_encoded_name"] == cwd.replace("/", "-")
        assert data["cwd"] == cwd
    finally:
        jsonl_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_find_session_codex(bootstrapped_client, tmp_path):
    """findSession resolves a Codex thread id to its rollout descriptor."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    thread_id = str(uuid.uuid4())
    cwd = str(tmp_path / "find-session-codex-fixture")
    Path(cwd).mkdir(parents=True, exist_ok=True)
    rollout_path = _write_fake_codex_rollout(thread_id, cwd=cwd)

    try:
        response = await bootstrapped_client.get(
            f"/api/v1/graph/compute_node/{compute_node_id}/findSession",
            params={"session_id": thread_id},
        )
        assert response.status_code == 200, response.text
        result = ApiResponse(**response.json())
        assert result.status == "SUCCESS", result.message

        data = result.data
        assert data["session_id"] == thread_id
        assert data["worker_type"] == "codex"
        assert data["transcript_path"] == str(rollout_path)
        assert data["project_encoded_name"] is None
        assert data["cwd"] == cwd
    finally:
        rollout_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_find_session_404(bootstrapped_client):
    """findSession returns 404 + FAIL when the session id is unknown."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    compute_node_id = _get_default_compute_node_id(bootstrap.json())

    response = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{compute_node_id}/findSession",
        params={"session_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert response.status_code == 404, response.text
    result = ApiResponse(**response.json())
    assert result.status == "FAIL"
    assert "not found" in (result.message or "").lower()


def test_flowpad_pty_pid_in_env():
    """Verify that FLOWPAD_PTY_SESSION_ID is set in the PTY environment.

    We verify this by checking the source code includes the env var injection.
    This test doesn't need the server — it's a pure source inspection.
    """
    import inspect

    from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider

    source = inspect.getsource(LocalComputeProvider.get_or_create_pty_session)
    assert "FLOWPAD_PTY_SESSION_ID" in source, "FLOWPAD_PTY_SESSION_ID should be set in get_or_create_pty_session"
