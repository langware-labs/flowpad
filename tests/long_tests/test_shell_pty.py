"""E2E test for Shell PTY lifecycle over WebSocket.

Scenario:
A. Create a shell → close it → must NOT appear in list-shells.
B. Create an idle shell → open WebSocket → call Shell.open() via rest_api_msg
   → PTY starts → SUCCESS response.
C. Send "echo hello" via terminal-command/input rest_api_msg → receive
   pty_output_msg on the WebSocket → verify "hello" in decoded PTY output.

Uses a real uvicorn server process (not the in-process ASGI client) so that
WebSocket receives can use asyncio.wait_for() timeouts instead of blocking
indefinitely on starlette TestClient's synchronous receive_json().
"""

import asyncio
import base64
import json
import os
import socket
import subprocess
import pytest
from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)
import sys
import tempfile
import time
import uuid

import httpx
import pytest
import websockets


# ---------------------------------------------------------------------------
# Live server fixture
# ---------------------------------------------------------------------------

def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _server_env(port: int, db_path: str) -> dict:
    env = os.environ.copy()
    env["SQLITE_DATABASE_PATH"] = db_path
    env["MINIHUB_HOST"] = "127.0.0.1"
    env["LOCAL_SERVER_PORT"] = str(port)
    env["FLOWPAD_SKIP_LOCK"] = "true"
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    env["PYTHONPATH"] = f"{repo_root}{os.pathsep}{env.get('PYTHONPATH', '')}"
    return env


async def _wait_for_server(base_url: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    async with httpx.AsyncClient() as client:
        while time.monotonic() < deadline:
            try:
                resp = await client.get(f"{base_url}/health/status")
                if resp.status_code == 200:
                    return
            except httpx.ConnectError:
                pass
            await asyncio.sleep(0.2)
    raise TimeoutError(f"Server at {base_url} did not become ready within {timeout}s")


@pytest.fixture()
async def pty_live_server():
    """Start a real uvicorn server with an isolated temp DB. Yields (port, base_url)."""
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"

    tmp_db = tempfile.NamedTemporaryFile(suffix=".db", prefix="flow_pty_", delete=False)
    tmp_db.close()
    db_path = tmp_db.name

    env = _server_env(port, db_path)
    proc = subprocess.Popen(
        [sys.executable, "-m", "flow_sdk.server.run"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        await _wait_for_server(base_url)
        yield port, base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
        for suffix in ("", "-shm", "-wal"):
            try:
                os.unlink(db_path + suffix)
            except FileNotFoundError:
                pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rest_api_msg(
    target_type: str,
    target_id: str,
    action: str,
    body: dict,
    method: str = "POST",
    sub_path: str | None = None,
    msg_id: str | None = None,
) -> dict:
    """Build a rest_api_msg payload for a graph entity action."""
    return {
        "message_type": "rest_api_msg",
        "message_id": msg_id or str(uuid.uuid4()),
        "method": method,
        "scope": [],
        "direct_resource_type": None,
        "target_typeid": {"type": target_type, "id": target_id},
        "action": action,
        "sub_path": sub_path,
        "query_params": None,
        "body": body,
    }


async def _recv(ws, timeout: float = 10.0) -> dict:
    """Receive one JSON message from the WebSocket with a timeout."""
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

@pytest.mark.timeout(90)
async def test_shell_pty_e2e(pty_live_server):
    """
    A. Create a shell → close it → not in list-shells.
    B. Open WebSocket → call Shell.open() → PTY starts → SUCCESS.
    C. Send echo input → receive pty_output_msg → 'hello' in decoded output.
    """
    port, base_url = pty_live_server

    async with httpx.AsyncClient(base_url=base_url, timeout=20.0) as http:
        # Bootstrap
        resp = await http.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"
        cn_id = resp.json()["data"]["default_compute_node"]["id"]

        # ── A: Create a closed shell → must NOT appear in list-shells ──
        r = await http.post(
            "/api/v1/graph/shell",
            json={"name": "closed-shell", "compute_node_id": cn_id},
        )
        assert r.status_code == 200
        closed_id = r.json()["data"]["id"]

        r = await http.post(f"/api/v1/graph/shell/{closed_id}/close")
        assert r.status_code == 200

        list_r = await http.get(
            f"/api/v1/graph/compute_node/{cn_id}/list-shells"
        )
        assert list_r.status_code == 200
        listed_ids = {s["id"] for s in list_r.json()["data"]}
        assert closed_id not in listed_ids, (
            "Closed shell must not appear in list-shells"
        )

        # ── B: Create idle shell → open WS → start PTY ───────────────────────
        r = await http.post(
            "/api/v1/graph/shell",
            json={"name": "pty-test", "compute_node_id": cn_id},
        )
        assert r.status_code == 200
        shell_id = r.json()["data"]["id"]

        ws_conn_id = str(uuid.uuid4())
        ws_url = f"ws://127.0.0.1:{port}/api/v1/connect/ws/{ws_conn_id}"

        async with websockets.connect(ws_url) as ws:
            # Consume WS connection confirmation
            confirm = await _recv(ws, timeout=5)
            assert confirm["message_type"] == "response_msg"
            assert confirm["status"] == "ok"

            # Call Shell.open() via rest_api_msg — PTY starts, routes output to ws_conn_id
            open_msg_id = str(uuid.uuid4())
            await ws.send(json.dumps(
                _rest_api_msg(
                    "shell", shell_id, "open",
                    body={"connection_id": ws_conn_id, "rows": 24, "cols": 80},
                    msg_id=open_msg_id,
                )
            ))

            # The server may send interleaved data_op_msg broadcasts before the
            # REST response. Collect messages until we find the ApiResponse.
            # The response may arrive at the top level (status=SUCCESS) or
            # wrapped in a response_msg envelope (content.status=SUCCESS).
            open_resp = None
            for _ in range(10):
                msg = await _recv(ws, timeout=15)
                status = msg.get("status")
                if status not in ("SUCCESS", "FAIL"):
                    content = msg.get("content")
                    if isinstance(content, dict):
                        status = content.get("status")
                if status in ("SUCCESS", "FAIL"):
                    open_resp = msg
                    open_resp["_resolved_status"] = status
                    break
            assert open_resp is not None and open_resp.get("_resolved_status") == "SUCCESS", (
                f"Shell.open() failed or not received: {open_resp}"
            )

            # ── C: Send echo input → receive pty_output_msg ──────────────────
            await ws.send(json.dumps(
                _rest_api_msg(
                    "compute_node", cn_id, "terminal-command",
                    body={"shell_id": shell_id, "data": "echo hello\n"},
                    sub_path="input",
                )
            ))

            # Collect PTY output until "hello" is found or 30 messages/timeout
            received_text = ""
            for _ in range(30):
                try:
                    msg = await _recv(ws, timeout=5)
                except asyncio.TimeoutError:
                    break

                # PTY output arrives as response_msg wrapping pty_output_msg
                content = msg.get("content")
                if isinstance(content, dict) and content.get("message_type") == "pty_output_msg":
                    raw_b64 = content.get("data", "")
                    if raw_b64:
                        received_text += base64.b64decode(raw_b64).decode("utf-8", errors="replace")
                # Some paths send pty_output_msg at top level
                elif msg.get("message_type") == "pty_output_msg":
                    raw_b64 = msg.get("data", "")
                    if raw_b64:
                        received_text += base64.b64decode(raw_b64).decode("utf-8", errors="replace")

                if "hello" in received_text:
                    break

            assert "hello" in received_text, (
                f"Expected 'hello' in PTY output after 'echo hello', got: {received_text!r}"
            )
