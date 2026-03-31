"""
Regression test: AgenticProcess.open() resumes after server restart.

Bug scenario
============
1. AgenticProcess is RUNNING (worker_session_id set, shell_id set, shell.status="running").
2. Server restarts — PTY dies, in-memory session_manager cleared.
3. User refreshes page → loader calls process.open().
4. BEFORE FIX: open() (formerly start()) returns "Shell session already active"
   (shell.status=="running"). Claude is never resumed.
5. AFTER FIX: open() detects stale PTY via Shell.start_pty()'s alive-check,
   cleans up, and restarts with `claude --resume <session_id>`.

These tests reproduce the entity-state and server-side aspects of the bug
without starting or stopping a real server process.
"""

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.responses.response import ApiResponse


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compute_node_id(bootstrap_resp) -> str:
    return bootstrap_resp.json()["data"]["default_compute_node"]["id"]


def _make_fake_jsonl(session_id: str) -> Path:
    """Write a minimal Claude JSONL transcript so _find_resumable_session finds it."""
    projects_dir = Path.home() / ".claude" / "projects" / "test-resume-bug"
    projects_dir.mkdir(parents=True, exist_ok=True)
    path = projects_dir / f"{session_id}.jsonl"
    entries = [
        {
            "type": "user",
            "sessionId": session_id,
            "cwd": "/tmp",
            "version": "1.0",
            "gitBranch": "",
            "slug": "test-session",
            "timestamp": "2024-01-01T00:00:00.000Z",
            "uuid": str(uuid.uuid4()),
            "message": {"role": "user", "content": "hello"},
        },
        {
            "type": "assistant",
            "sessionId": session_id,
            "cwd": "/tmp",
            "version": "1.0",
            "gitBranch": "",
            "slug": "test-session",
            "timestamp": "2024-01-01T00:00:01.000Z",
            "uuid": str(uuid.uuid4()),
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Hello!"}],
                "stop_reason": "tool_use",  # still "running" — mid-turn
            },
        },
    ]
    path.write_text("\n".join(json.dumps(e) for e in entries))
    return path


async def _create_post_restart_state(client, compute_node_id: str, session_id: str):
    """
    Directly create the DB entities in the state they would be in after a server
    restart: shell.status="running" but no real PTY, process.state.status="running".

    Returns (process_id, shell_id).
    """
    shell_resp = await client.post(
        "/api/v1/graph/shell",
        json={
            "name": f"Claude - {session_id[:8]}",
            "status": "running",          # <-- stale: PTY is dead after restart
            "compute_node_id": compute_node_id,
        },
    )
    assert shell_resp.status_code == 200, shell_resp.text
    shell_id = ApiResponse(**shell_resp.json()).data["id"]

    proc_resp = await client.post(
        "/api/v1/graph/agentic_process",
        json={
            "compute_node_id": f"compute_node-{compute_node_id}",
            "shell_id": shell_id,
            "worker_session_id": session_id,
            "status": "running",   # <-- stale: Claude exited at restart
        },
    )
    assert proc_resp.status_code == 200, proc_resp.text
    process_id = ApiResponse(**proc_resp.json()).data["id"]

    return process_id, shell_id


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_loader_sees_no_error_signal_after_restart(bootstrapped_client):
    """
    After server restart the loader reads both entities as RUNNING — no redirect,
    no error, no resume call.  This is the root cause of the bug: entity state
    gives the frontend no indication that Claude stopped.
    """
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap)
    session_id = str(uuid.uuid4())

    process_id, shell_id = await _create_post_restart_state(
        bootstrapped_client, cn_id, session_id
    )

    # --- Simulate loader: GET process ---
    proc_resp = await bootstrapped_client.get(
        f"/api/v1/graph/agentic_process/{process_id}"
    )
    assert proc_resp.status_code == 200
    proc = ApiResponse(**proc_resp.json()).data

    # Process looks RUNNING → loader does NOT call process.open()
    assert proc["status"] == "running", (
        "Process shows RUNNING after restart — loader has no reason to call open()"
    )
    assert proc["shell_id"] == shell_id, "shell_id is set — loader will look up the shell"
    assert proc["worker_session_id"] == session_id, "worker_session_id preserved"

    # --- Simulate loader: GET shell ---
    shell_resp = await bootstrapped_client.get(f"/api/v1/graph/shell/{shell_id}")
    assert shell_resp.status_code == 200
    shell = ApiResponse(**shell_resp.json()).data

    # Shell shows RUNNING → loader does NOT redirect to /dock/shell
    assert shell["status"] == "running", (
        "Shell shows RUNNING after restart — loader passes the status check and "
        "renders the terminal WITHOUT calling process.open()"
    )

    # BUG: Neither entity signals 'needs resume'.
    # The loader sets dataContext.activeShellId = shell_id and returns.
    # InteractiveTerminal then calls shell.startPty() which hits terminal-command/attach
    # → not_found → terminal-command/start → plain PTY (no Claude).


@pytest.mark.asyncio
async def test_open_correctly_reconnects_claude_session(bootstrapped_client):
    """
    process.open() is the correct server-side path to restart Claude after
    a server restart.  When the JSONL transcript exists on disk, open() builds
    a 'claude --resume <session_id>' command and starts a new PTY with it.

    After the fix: open() detects the stale PTY and resumes Claude.
    """
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap)
    session_id = str(uuid.uuid4())
    jsonl_path = _make_fake_jsonl(session_id)

    try:
        process_id, shell_id = await _create_post_restart_state(
            bootstrapped_client, cn_id, session_id
        )

        open_resp = await bootstrapped_client.post(
            f"/api/v1/graph/agentic_process/{process_id}/open",
        )
        assert open_resp.status_code == 200, open_resp.text
        open_result = ApiResponse(**open_resp.json())

        assert open_result.status == "SUCCESS", (
            f"open() failed: {open_result.message}\n"
            "After fix: open() must detect dead PTY and resume Claude."
        )
        assert open_result.data["worker_session_id"] == session_id
        assert open_result.data["is_resume"] is True

        proc_resp = await bootstrapped_client.get(
            f"/api/v1/graph/agentic_process/{process_id}"
        )
        proc = ApiResponse(**proc_resp.json()).data
        assert proc["status"] == "running"
        assert proc["shell_id"] is not None
        assert proc["worker_session_id"] == session_id

    finally:
        jsonl_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_open_registers_on_exit_so_status_updates(bootstrapped_client):
    """
    After process.open() resumes Claude in a new PTY, closing the shell must
    update process.state.status to "idle".  This requires open() to register
    an on_exit callback when it spawns the PTY.

    After fix: open() restarts PTY with Claude + on_exit → shell close → process idle.
    """
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap)
    session_id = str(uuid.uuid4())
    jsonl_path = _make_fake_jsonl(session_id)

    try:
        process_id, shell_id = await _create_post_restart_state(
            bootstrapped_client, cn_id, session_id
        )

        open_resp = await bootstrapped_client.post(
            f"/api/v1/graph/agentic_process/{process_id}/open",
        )
        assert ApiResponse(**open_resp.json()).status == "SUCCESS", (
            ApiResponse(**open_resp.json()).message
        )

        await bootstrapped_client.post(f"/api/v1/graph/shell/{shell_id}/close")

        proc_resp = await bootstrapped_client.get(
            f"/api/v1/graph/agentic_process/{process_id}"
        )
        proc = ApiResponse(**proc_resp.json()).data
        assert proc["status"] != "running", (
            "BUG: process.status stays 'running' after the shell closes.\n"
            "on_exit was never registered because open() was not called properly."
        )

    finally:
        jsonl_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_open_is_idempotent_when_pty_alive(bootstrapped_client):
    """
    When the PTY is genuinely alive, process.open() must be a no-op: returns
    SUCCESS without spawning a second shell process, and the shell_id is unchanged.

    This is the normal case (no server restart) and must work after the fix.

    After fix: open() detects alive PTY via Shell.start_pty() and returns SUCCESS (no-op).
    """
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap)
    session_id = str(uuid.uuid4())
    jsonl_path = _make_fake_jsonl(session_id)

    try:
        process_id, shell_id = await _create_post_restart_state(
            bootstrapped_client, cn_id, session_id
        )

        # Open a real PTY (simulates a genuinely alive shell)
        shell_open_resp = await bootstrapped_client.post(
            f"/api/v1/graph/shell/{shell_id}/open",
            json={"cols": 80, "rows": 24},
        )
        assert ApiResponse(**shell_open_resp.json()).status == "SUCCESS", shell_open_resp.text

        # process.open() on a live PTY must be a no-op — returns SUCCESS, same shell_id
        open_resp = await bootstrapped_client.post(
            f"/api/v1/graph/agentic_process/{process_id}/open",
        )
        open_result = ApiResponse(**open_resp.json())
        assert open_result.status == "SUCCESS", open_result.message
        assert open_result.data["shell_id"] == shell_id, (
            "open() must reuse the existing shell when PTY is alive"
        )

    finally:
        jsonl_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_open_without_session_transcript_starts_fresh(bootstrapped_client):
    """
    When no JSONL transcript exists, open() falls back to a fresh Claude session.

    After fix: open() spawns claude with --session-id (no --resume) when no transcript found.
    """
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap)
    session_id = str(uuid.uuid4())  # no JSONL on disk

    process_id, shell_id = await _create_post_restart_state(
        bootstrapped_client, cn_id, session_id
    )

    open_resp = await bootstrapped_client.post(
        f"/api/v1/graph/agentic_process/{process_id}/open",
    )
    assert open_resp.status_code == 200, open_resp.text
    open_result = ApiResponse(**open_resp.json())

    assert open_result.status == "SUCCESS", (
        f"open() returned: {open_result.status} — {open_result.message}"
    )
    assert open_result.data["worker_session_id"] == session_id
    assert open_result.data["is_resume"] is False


@pytest.mark.asyncio
async def test_open_preserves_session_id_after_restart(bootstrapped_client):
    """
    After server restart, process.open() must preserve the original worker_session_id
    so the Claude transcript is not lost.

    """
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap)
    session_id = str(uuid.uuid4())
    jsonl_path = _make_fake_jsonl(session_id)

    try:
        process_id, old_shell_id = await _create_post_restart_state(
            bootstrapped_client, cn_id, session_id
        )

        open_resp = await bootstrapped_client.post(
            f"/api/v1/graph/agentic_process/{process_id}/open",
        )
        assert open_resp.status_code == 200, open_resp.text
        open_result = ApiResponse(**open_resp.json())
        assert open_result.status == "SUCCESS", (
            f"open() failed: {open_result.message}"
        )

        assert open_result.data["worker_session_id"] == session_id
        new_shell_id = open_result.data["shell_id"]
        assert new_shell_id is not None

        proc_resp = await bootstrapped_client.get(
            f"/api/v1/graph/agentic_process/{process_id}"
        )
        proc = ApiResponse(**proc_resp.json()).data
        assert proc["worker_session_id"] == session_id
        assert proc["shell_id"] == new_shell_id
        assert proc["status"] == "running"

    finally:
        jsonl_path.unlink(missing_ok=True)
