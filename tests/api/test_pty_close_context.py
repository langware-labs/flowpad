"""Tests for PTY close over plain HTTP.

After the fix, terminal-command/close works over plain HTTP (no WebSocket needed).
It writes state=closed to the ShellRecord on disk so list-shell-sessions
excludes it — fixing the "close all → refresh → tabs back" bug.

terminal-command/start still requires WebSocket context (it needs to stream PTY
output back to the caller), so that one correctly remains WebSocket-only.
"""

import pytest

from flow_sdk.responses.response import ApiResponse


async def _get_compute_node_id(client) -> str:
    resp = await client.get("/api/v1/graph/compute_node")
    assert resp.status_code == 200
    nodes = ApiResponse(**resp.json()).data
    assert nodes and len(nodes) >= 1, "No compute nodes found after bootstrap"
    return nodes[0]["id"]


@pytest.mark.asyncio
async def test_pty_close_works_over_http(bootstrapped_client):
    """terminal-command/close succeeds over plain HTTP (no WebSocket needed).

    Session not found is treated as idempotent success.
    """
    compute_node_id = await _get_compute_node_id(bootstrapped_client)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/terminal-command/close",
        json={"shell_id": "test-session-123"},
    )
    result = ApiResponse(**response.json())
    # Either SUCCESS (session not found → idempotent) or FAIL with a real reason
    # — the key is it must NOT be "Invalid request context"
    assert result.message != "Invalid request context"
    assert result.status == "SUCCESS"


@pytest.mark.asyncio
async def test_pty_start_still_requires_websocket_context(bootstrapped_client):
    """terminal-command/start still requires WebSocket context (streams PTY output)."""
    compute_node_id = await _get_compute_node_id(bootstrapped_client)

    response = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{compute_node_id}/terminal-command/start",
        json={"shell_id": "test-session-456", "rows": 24, "cols": 80},
    )
    result = ApiResponse(**response.json())
    assert result.status == "FAIL"
    # start fails because it needs to stream PTY output over WebSocket
    assert "WebSocket" in result.message or "Invalid request" in result.message or "shell_id" in result.message
