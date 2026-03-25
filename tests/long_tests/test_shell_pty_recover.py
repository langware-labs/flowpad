"""E2E test for Shell PTY recovery via WebSocket.

Scenarios:
A. Reattach — WS1 starts a PTY and exchanges data; WS2 (new connection) calls
   terminal-command/attach and receives status="reattached" plus a replay of
   the previous output. WS2 can then send new input and receive output.

B. Dead session / not_found — terminal-command/attach on a shell with no active
   PTY session returns status="not_found". The shell is then opened fresh via
   Shell.open() and PTY I/O works normally.

Uses a real uvicorn subprocess so WebSocket receives can use
asyncio.wait_for() timeouts instead of blocking indefinitely.
"""

import asyncio
import base64
import json
import os
import signal
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
    env["MINIHUB_PORT"] = str(port)
    env["FLOWPAD_SKIP_LOCK"] = "true"
    env["FLOWPAD_DEV"] = "false"
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
async def pty_recover_server():
    """Start a real uvicorn server. Yields (port, base_url)."""
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"

    tmp_db = tempfile.NamedTemporaryFile(suffix=".db", prefix="flow_recover_", delete=False)
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
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def _open_shell_via_ws(ws, shell_id: str, conn_id: str) -> dict:
    """Call Shell.open() over WS. Returns the SUCCESS response."""
    await ws.send(json.dumps(
        _rest_api_msg("shell", shell_id, "open", body={"connection_id": conn_id, "rows": 24, "cols": 80})
    ))
    for _ in range(10):
        msg = await _recv(ws, timeout=15)
        if msg.get("status") in ("SUCCESS", "FAIL"):
            return msg
    raise AssertionError("Shell.open() response not received")


async def _collect_pty_output(ws, keyword: str, max_msgs: int = 30, per_msg_timeout: float = 5.0) -> str:
    """Consume WS messages until `keyword` appears in decoded PTY output or we give up."""
    text = ""
    for _ in range(max_msgs):
        try:
            msg = await _recv(ws, timeout=per_msg_timeout)
        except asyncio.TimeoutError:
            break
        content = msg.get("content")
        if isinstance(content, dict) and content.get("message_type") == "pty_output_msg":
            raw = content.get("data", "")
            if raw:
                text += base64.b64decode(raw).decode("utf-8", errors="replace")
        elif msg.get("message_type") == "pty_output_msg":
            raw = msg.get("data", "")
            if raw:
                text += base64.b64decode(raw).decode("utf-8", errors="replace")
        if keyword in text:
            break
    return text


async def _send_input(ws, cn_id: str, shell_id: str, data: str) -> None:
    await ws.send(json.dumps(
        _rest_api_msg("compute_node", cn_id, "terminal-command",
                      body={"shell_id": shell_id, "data": data}, sub_path="input")
    ))


async def _attach_via_ws(ws, cn_id: str, shell_id: str, since_seq: int = 0) -> dict:
    """Send terminal-command/attach and return the response.

    _attach_pty_session returns ApiSuccessResponse(data=ResponseMessage.model_dump()).
    ws_rest.py detects data.message_type == "response_msg" and sends the inner
    ResponseMessage dict directly, so the WS client receives:
        {"message_type": "response_msg", "content": {"status": "reattached"|"not_found", ...}}
    rather than {"status": "SUCCESS", ...}.
    """
    msg_id = str(uuid.uuid4())
    await ws.send(json.dumps(
        _rest_api_msg("compute_node", cn_id, "terminal-command",
                      body={"shell_id": shell_id, "since_seq": since_seq},
                      sub_path="attach", msg_id=msg_id)
    ))
    for _ in range(15):
        msg = await _recv(ws, timeout=10)
        # Plain ApiResponse (e.g., error before ResponseMessage is built)
        if msg.get("status") in ("SUCCESS", "FAIL"):
            return msg
        # ResponseMessage unwrapped by ws_rest: {"message_type": "response_msg", "content": {...}}
        if msg.get("message_type") == "response_msg":
            content = msg.get("content", {})
            if isinstance(content, dict) and content.get("status") in ("reattached", "not_found"):
                return msg
    raise AssertionError("terminal-command/attach response not received")


# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

@pytest.mark.timeout(120)
async def test_shell_pty_recover(pty_recover_server):
    """
    A. Reattach: WS2 reattaches to a running PTY started by WS1.
       Expects status="reattached" and replay of previous output.
       WS2 can then send new input and receive output.

    B. Not-found: attach to a shell that has no PTY session returns
       status="not_found". Opening the shell fresh then works normally.
    """
    port, base_url = pty_recover_server
    ws_base = f"ws://127.0.0.1:{port}"

    async with httpx.AsyncClient(base_url=base_url, timeout=20.0) as http:
        # Bootstrap
        resp = await http.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"
        cn_id = resp.json()["data"]["default_compute_node"]["id"]

        # ── A: Reattach ────────────────────────────────────────────────────────
        # Create shell
        r = await http.post("/api/v1/graph/shell",
                            json={"name": "reattach-test", "compute_node_id": cn_id})
        assert r.status_code == 200
        shell_a = r.json()["data"]["id"]

        conn1_id = str(uuid.uuid4())
        conn2_id = str(uuid.uuid4())

        async with websockets.connect(f"{ws_base}/api/v1/connect/ws/{conn1_id}") as ws1:
            # Consume WS connection confirmation
            confirm = await _recv(ws1, timeout=5)
            assert confirm["status"] == "ok"

            # Start PTY on WS1
            open_resp = await _open_shell_via_ws(ws1, shell_a, conn1_id)
            assert open_resp["status"] == "SUCCESS", f"Shell.open() failed: {open_resp}"

            # Echo "reattach_hello" so there is replay content
            await _send_input(ws1, cn_id, shell_a, "echo reattach_hello\n")
            output_ws1 = await _collect_pty_output(ws1, "reattach_hello")
            assert "reattach_hello" in output_ws1, (
                f"WS1 did not receive echo: {output_ws1!r}"
            )

            # WS2 reattaches — PTY is still running
            async with websockets.connect(f"{ws_base}/api/v1/connect/ws/{conn2_id}") as ws2:
                confirm2 = await _recv(ws2, timeout=5)
                assert confirm2["status"] == "ok"

                attach_resp = await _attach_via_ws(ws2, cn_id, shell_a, since_seq=0)

                # Response arrives as unwrapped ResponseMessage (see _attach_via_ws docstring)
                content = attach_resp.get("content", {})
                reattach_status = content.get("status") if isinstance(content, dict) else None
                assert reattach_status == "reattached", (
                    f"Expected status='reattached', got: {attach_resp}"
                )

                # Replay should include the previous "reattach_hello" echo
                # (sent as separate pty_output_msg messages before the response)
                # Drain any pending replay messages briefly
                replay_text = ""
                for _ in range(20):
                    try:
                        msg = await _recv(ws2, timeout=1.0)
                    except asyncio.TimeoutError:
                        break
                    raw = None
                    content_m = msg.get("content")
                    if isinstance(content_m, dict) and content_m.get("message_type") == "pty_output_msg":
                        raw = content_m.get("data", "")
                    elif msg.get("message_type") == "pty_output_msg":
                        raw = msg.get("data", "")
                    if raw:
                        replay_text += base64.b64decode(raw).decode("utf-8", errors="replace")

                # Send new input via WS2 and confirm PTY is live
                await _send_input(ws2, cn_id, shell_a, "echo ws2_alive\n")
                output_ws2 = await _collect_pty_output(ws2, "ws2_alive")
                assert "ws2_alive" in output_ws2, (
                    f"WS2 did not receive echo after reattach: {output_ws2!r}"
                )

        # ── B: Not-found — attach to idle shell with no PTY ────────────────────
        r2 = await http.post("/api/v1/graph/shell",
                             json={"name": "no-pty-shell", "compute_node_id": cn_id})
        assert r2.status_code == 200
        shell_b = r2.json()["data"]["id"]

        conn3_id = str(uuid.uuid4())
        async with websockets.connect(f"{ws_base}/api/v1/connect/ws/{conn3_id}") as ws3:
            confirm3 = await _recv(ws3, timeout=5)
            assert confirm3["status"] == "ok"

            # Attach to a shell that was never opened — no PTY session exists
            attach_resp2 = await _attach_via_ws(ws3, cn_id, shell_b, since_seq=0)

            content2 = attach_resp2.get("content", {})
            not_found_status = content2.get("status") if isinstance(content2, dict) else None
            assert not_found_status == "not_found", (
                f"Expected status='not_found', got: {attach_resp2}"
            )

            # Now open the shell fresh — PTY should start normally
            open_resp2 = await _open_shell_via_ws(ws3, shell_b, conn3_id)
            assert open_resp2["status"] == "SUCCESS", (
                f"Shell.open() after not_found failed: {open_resp2}"
            )

            # Verify PTY is live
            await _send_input(ws3, cn_id, shell_b, "echo fresh_start\n")
            output_ws3 = await _collect_pty_output(ws3, "fresh_start")
            assert "fresh_start" in output_ws3, (
                f"PTY not live after fresh open: {output_ws3!r}"
            )
