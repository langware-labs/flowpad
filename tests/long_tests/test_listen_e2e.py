"""
E2E test: real server + real CLI subprocess → listen webhook → sniffer → WebSocket flow_data_msg.

Validates the full pipeline:
  1. Start a real uvicorn server on a random port (isolated temp DB)
  2. Bootstrap + enable sniffer hook
  3. Connect a WebSocket and register a watch on the sniffer entity
  4. Run `flow hooks report` as a subprocess, piping dummy event JSON to stdin
  5. Assert the WebSocket receives a flow_data_msg with the expected payload
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time

import httpx
import pytest
import websockets

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _server_env(port: int, db_path: str) -> dict:
    """Build an environment dict for the server subprocess."""
    env = os.environ.copy()
    env["SQLITE_DATABASE_PATH"] = db_path
    env["MINIHUB_HOST"] = "127.0.0.1"
    env["LOCAL_SERVER_PORT"] = str(port)
    env["FLOWPAD_SKIP_LOCK"] = "true"  # bypass singleton guard when dev server is running
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    env["PYTHONPATH"] = f"{repo_root}{os.pathsep}{env.get('PYTHONPATH', '')}"
    return env


async def _wait_for_server(base_url: str, timeout: float = 30.0) -> None:
    """Poll GET /health/status until 200 or timeout."""
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
async def live_server(allocate_ports):
    """Start a real uvicorn server on a free port with an isolated temp DB.

    Uses ``allocate_ports`` so teardown kills any process still holding the port.
    Yields (port, base_url).
    """
    port, = allocate_ports()
    base_url = f"http://127.0.0.1:{port}"

    tmp_db = tempfile.NamedTemporaryFile(suffix=".db", prefix="flow_e2e_", delete=False)
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
# Test
# ---------------------------------------------------------------------------

@pytest.mark.timeout(60)
async def test_listen_e2e_real_server_cli_subprocess(live_server):
    """Full E2E: real server, real CLI subprocess, real WebSocket."""
    port, base_url = live_server

    async with httpx.AsyncClient(base_url=base_url, timeout=20.0) as client:
        # 1. Bootstrap
        resp = await client.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"

        # 2. Enable sniffer hook
        resp = await client.post("/api/v1/graph/agent_hook/hooks-sniffer")
        assert resp.status_code == 200, f"hooks-sniffer failed: {resp.text}"
        sniffer_data = resp.json()["data"]
        assert sniffer_data["enabled"] is True
        sniffer_hook_id = sniffer_data["hook_id"]

        # 3. Connect WebSocket + register watch
        conn_id = "e2e-test-conn-1"
        ws_url = f"ws://127.0.0.1:{port}/api/v1/connect/ws/{conn_id}"

        async with websockets.connect(ws_url) as ws:
            # Consume connection confirmation
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            confirm = json.loads(raw)
            assert confirm["message_type"] == "response_msg"
            assert confirm["status"] == "ok"

            # Register watch on the sniffer hook entity
            resp = await client.post(
                f"/api/v1/graph/agent_hook/{sniffer_hook_id}/watch",
                json={"connection_id": conn_id},
            )
            assert resp.status_code == 200, f"watch failed: {resp.text}"

            # 4. Call `flow hooks report` as a subprocess
            dummy_event = {
                "hook_event_name": "test_ping",
                "source": "e2e_test",
                "session_id": "test-session-123",
            }

            repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

            cli_env = os.environ.copy()
            cli_env["AGENT_HOOKS_REPORT_URL"] = f"http://127.0.0.1:{port}/api/v1/webhook/listen"
            cli_env["PYTHONPATH"] = f"{repo_root}{os.pathsep}{cli_env.get('PYTHONPATH', '')}"

            cli_proc = await asyncio.create_subprocess_exec(
                sys.executable, "-m", "flow_sdk.cli.flow_cli",
                "hooks", "report",
                f"--hook-entry-id={sniffer_hook_id}",
                "--name=test_sniffer",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=cli_env,
            )
            stdout, stderr = await asyncio.wait_for(
                cli_proc.communicate(input=json.dumps(dummy_event).encode()),
                timeout=10,
            )
            assert cli_proc.returncode == 0, (
                f"CLI exited with code {cli_proc.returncode}\n"
                f"stdout: {stdout.decode()}\nstderr: {stderr.decode()}"
            )

            # 5. Validate flow_data_msg on WebSocket
            deadline = time.monotonic() + 10
            matched_msg = None
            while time.monotonic() < deadline:
                remaining = max(0.1, deadline - time.monotonic())
                try:
                    raw_msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                msg = json.loads(raw_msg)
                if msg.get("message_type") != "flow_data_msg":
                    continue
                flow_data = msg.get("flow_data", {})
                if flow_data.get("attributes", {}).get("webhook_type") != "agent_hook":
                    continue
                content_raw = flow_data.get("content", "")
                try:
                    content = json.loads(content_raw)
                except (json.JSONDecodeError, TypeError):
                    continue
                hook_data = content.get("hook_data", {})
                if (content.get("agent_hook_id") == sniffer_hook_id
                        and hook_data.get("hook_event_name") == "test_ping"):
                    matched_msg = content
                    break

            assert matched_msg is not None, (
                f"No flow_data_msg with agent_hook_id={sniffer_hook_id} received within 10s"
            )
            assert matched_msg["webhook_type"] == "agent_hook"
            hook_data = matched_msg.get("hook_data", {})
            assert hook_data.get("hook_event_name") == "test_ping"
            assert hook_data.get("session_id") == "test-session-123"
