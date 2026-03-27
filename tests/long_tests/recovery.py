"""E2E recovery tests — AgenticProcess + Shell after server restart.

Mirrors the TypeScript agentic_process_stress.test.ts PTY lifecycle and
restore-from-DB suites, but runs as Python long tests against a real server.

Scenario A: PTY lifecycle
  1. Create AgenticProcess
  2. open() → get shell_id + worker_session_id
  3. Attach WS to shell, verify Claude Code starts up
  4. Send a simple shell echo → verify output arrives

Scenario B: Server-restart recovery
  1. Same as A (Claude running)
  2. SIGKILL the server → simulates crash
  3. Verify WS connection drops
  4. Restart server with the same DB (entities persist)
  5. GET process → state still shows "running" (stale — no signal yet)
  6. Call open() again → server detects dead PTY, resumes with --resume
  7. Verify open() returns is_resume=True
  8. Attach to new shell, verify PTY is alive
  9. Send "echo hello_after_recovery" → verify it appears in PTY

These tests require:
  - DEEP_TESTING=true
  - `claude` CLI in PATH (for Claude Code PTY)
  - Network access for the Claude model
"""

import asyncio
import base64
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid

import httpx
import pytest
import websockets

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)

# ---------------------------------------------------------------------------
# Server fixture helpers (shared pattern with test_shell_pty_recover.py)
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


def _start_server(port: int, db_path: str) -> subprocess.Popen:
    env = _server_env(port, db_path)
    return subprocess.Popen(
        [sys.executable, "-m", "flow_sdk.server.run"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


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
async def recovery_server():
    """Start a real uvicorn server. Yields (port, base_url, db_path, proc).

    Callers can kill proc and restart a fresh one against the same db_path.
    """
    port = _find_free_port()
    base_url = f"http://127.0.0.1:{port}"

    tmp_db = tempfile.NamedTemporaryFile(suffix=".db", prefix="flow_recovery_", delete=False)
    tmp_db.close()
    db_path = tmp_db.name

    proc = _start_server(port, db_path)
    try:
        await _wait_for_server(base_url)
        yield port, base_url, db_path, proc
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
# WS / REST helpers (mirrored from test_shell_pty_recover.py)
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


async def _collect_pty_output(
    ws,
    keyword: str | None = None,
    max_msgs: int = 60,
    per_msg_timeout: float = 5.0,
) -> str:
    """Drain PTY output messages until keyword found or max_msgs exhausted."""
    text = ""
    for _ in range(max_msgs):
        try:
            msg = await _recv(ws, timeout=per_msg_timeout)
        except asyncio.TimeoutError:
            break
        raw = None
        content = msg.get("content")
        if isinstance(content, dict) and content.get("message_type") == "pty_output_msg":
            raw = content.get("data", "")
        elif msg.get("message_type") == "pty_output_msg":
            raw = msg.get("data", "")
        if raw:
            text += base64.b64decode(raw).decode("utf-8", errors="replace")
        if keyword and keyword in text:
            break
    return text


async def _attach_shell(ws, cn_id: str, shell_id: str, conn_id: str) -> dict:
    """Call terminal-command/attach and return the response dict."""
    await ws.send(json.dumps(
        _rest_api_msg(
            "compute_node", cn_id, "terminal-command",
            body={"shell_id": shell_id, "since_seq": 0},
            sub_path="attach",
        )
    ))
    for _ in range(20):
        msg = await _recv(ws, timeout=10)
        if msg.get("status") in ("SUCCESS", "FAIL"):
            return msg
        if msg.get("message_type") == "response_msg":
            content = msg.get("content", {})
            if isinstance(content, dict) and content.get("status") in ("reattached", "not_found"):
                return msg
    raise AssertionError("terminal-command/attach response not received")


async def _send_pty_input(ws, cn_id: str, shell_id: str, data: str) -> None:
    await ws.send(json.dumps(
        _rest_api_msg(
            "compute_node", cn_id, "terminal-command",
            body={"shell_id": shell_id, "data": data},
            sub_path="input",
        )
    ))


async def _wait_ws_disconnect(ws, timeout: float = 15.0) -> None:
    """Wait until the WS connection closes (server crash or shutdown)."""
    try:
        await asyncio.wait_for(ws.wait_closed(), timeout=timeout)
    except asyncio.TimeoutError:
        raise AssertionError(f"WS did not close within {timeout}s after server kill")


# ---------------------------------------------------------------------------
# Scenario A — PTY lifecycle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(120)
async def test_proc_pty_lifecycle(recovery_server):
    """Create a process, open() it, attach PTY, send echo, verify output.

    Mirrors TypeScript Suite 1 — PTY lifecycle:
      proc = new AgenticProcess(...)
      proc.open() → shell_id
      shell.startPty() → wait replayDone
      proc.sendInput('echo hello_pty') → 'hello_pty' in PTY output
    """
    port, base_url, db_path, _srv = recovery_server
    ws_base = f"ws://127.0.0.1:{port}"
    conn_id = str(uuid.uuid4())

    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
        # Bootstrap
        resp = await http.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"
        cn_id = resp.json()["data"]["default_compute_node"]["id"]

        # Create AgenticProcess
        proc_resp = await http.post(
            "/api/v1/graph/agentic_process",
            json={"compute_node_id": f"compute_node-{cn_id}"},
        )
        assert proc_resp.status_code == 200, proc_resp.text
        process_id = proc_resp.json()["data"]["id"]

        # open() — starts Claude Code in a new PTY
        open_resp = await http.post(
            f"/api/v1/graph/agentic_process/{process_id}/open",
        )
        assert open_resp.status_code == 200, open_resp.text
        open_data = open_resp.json()["data"]
        shell_id = open_data["shell_id"]
        worker_session_id = open_data["worker_session_id"]
        assert shell_id, "open() must return a shell_id"
        assert worker_session_id, "open() must return a worker_session_id"

        async with websockets.connect(f"{ws_base}/api/v1/connect/ws/{conn_id}") as ws:
            confirm = await _recv(ws, timeout=5)
            assert confirm["status"] == "ok"

            # Attach to the shell's PTY
            attach_resp = await _attach_shell(ws, cn_id, shell_id, conn_id)
            content = attach_resp.get("content", {})
            assert isinstance(content, dict) and content.get("status") == "reattached", (
                f"Expected reattached, got: {attach_resp}"
            )

            # Wait for Claude Code to emit something (any PTY output = PTY alive)
            # Claude startup can take 5–10s; wait up to 30s
            output = await _collect_pty_output(ws, keyword=None, max_msgs=80, per_msg_timeout=2.0)
            assert len(output) > 0, "PTY produced no output — Claude Code may not have started"

            # Send a shell echo to confirm PTY is interactive
            echo_token = f"echo_token_{uuid.uuid4().hex[:8]}"
            await _send_pty_input(ws, cn_id, shell_id, f"echo {echo_token}\r")

            echo_output = await _collect_pty_output(ws, keyword=echo_token, max_msgs=40, per_msg_timeout=3.0)
            assert echo_token in echo_output, (
                f"echo token not found in PTY output.\n"
                f"Token: {echo_token!r}\n"
                f"Output: {echo_output!r}"
            )


# ---------------------------------------------------------------------------
# Scenario B — Server-restart recovery
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(240)
async def test_proc_recovery_after_server_restart(recovery_server):
    """Full kill-restart recovery cycle.

    Mirrors TypeScript Suite 2 — Restore from DB:
      proc.open() → Claude running
      kill server                      ← simulates crash
      WS disconnects
      restart server (same DB)
      GET process → state still "running" (stale entity, no signal)
      open() again → is_resume=True, new shell_id
      attach new shell → PTY alive
      echo test → response arrives

    This test is the Python equivalent of:
      'restore from DB: open() + prompt() × 2 → hola appears twice'
    """
    port, base_url, db_path, srv_proc = recovery_server
    ws_base = f"ws://127.0.0.1:{port}"
    conn_id_1 = str(uuid.uuid4())

    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
        # ── Phase 1: Bootstrap + create process ────────────────────────────
        resp = await http.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"
        cn_id = resp.json()["data"]["default_compute_node"]["id"]

        proc_resp = await http.post(
            "/api/v1/graph/agentic_process",
            json={"compute_node_id": f"compute_node-{cn_id}"},
        )
        assert proc_resp.status_code == 200, proc_resp.text
        process_id = proc_resp.json()["data"]["id"]

        # ── Phase 2: open() → Claude running ───────────────────────────────
        open_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
        assert open_resp.status_code == 200, open_resp.text
        open_data = open_resp.json()["data"]
        shell_id_before = open_data["shell_id"]
        worker_session_id = open_data["worker_session_id"]
        assert shell_id_before, "open() must return a shell_id"

    # ── Phase 3: Connect WS, confirm PTY alive ─────────────────────────
    async with websockets.connect(f"{ws_base}/api/v1/connect/ws/{conn_id_1}") as ws:
        confirm = await _recv(ws, timeout=5)
        assert confirm["status"] == "ok"

        attach_resp = await _attach_shell(ws, cn_id, shell_id_before, conn_id_1)
        content = attach_resp.get("content", {})
        assert isinstance(content, dict) and content.get("status") == "reattached", (
            f"Expected reattached, got: {attach_resp}"
        )

        # Give Claude enough time to emit some startup output
        output_before = await _collect_pty_output(ws, keyword=None, max_msgs=60, per_msg_timeout=2.0)
        assert len(output_before) > 0, "No PTY output before restart — Claude may not have started"

        # ── Phase 4: SIGKILL the server ────────────────────────────────────
        srv_proc.kill()
        srv_proc.wait(timeout=5)

        # Confirm WS disconnects
        await _wait_ws_disconnect(ws, timeout=15.0)

    # ── Phase 5: Restart server with same DB ───────────────────────────
    new_srv = _start_server(port, db_path)
    try:
        await _wait_for_server(base_url, timeout=30.0)

        conn_id_2 = str(uuid.uuid4())
        async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
            # Bootstrap is idempotent — re-run to confirm server is live
            resp = await http.get("/api/v1/graph/bootstrap")
            assert resp.status_code == 200, f"Post-restart bootstrap failed: {resp.text}"

            # ── Phase 6: Process still in DB, state shows "running" (stale) ──
            proc_get = await http.get(f"/api/v1/graph/agentic_process/{process_id}")
            assert proc_get.status_code == 200, f"Process not found after restart: {proc_get.text}"
            proc_data = proc_get.json()["data"]
            assert proc_data["worker_session_id"] == worker_session_id, (
                "worker_session_id must survive server restart (persisted in DB)"
            )
            # State likely "running" — stale, no live signal yet
            stale_status = proc_data.get("state", {}).get("status")
            # (informational: not asserted, just logged)

            # ── Phase 7: open() detects dead PTY and resumes ───────────────
            open2_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
            assert open2_resp.status_code == 200, f"open() after restart failed: {open2_resp.text}"
            open2_data = open2_resp.json()["data"]

            shell_id_after = open2_data["shell_id"]
            is_resume = open2_data.get("is_resume", False)
            assert shell_id_after, "open() after restart must return a shell_id"
            assert is_resume is True, (
                f"open() after restart must resume the Claude session (is_resume=True).\n"
                f"Got: {open2_data}"
            )
            assert open2_data["worker_session_id"] == worker_session_id, (
                "worker_session_id must be preserved through recovery"
            )

            # ── Phase 8: Attach new shell, verify PTY alive ────────────────
        async with websockets.connect(f"{ws_base}/api/v1/connect/ws/{conn_id_2}") as ws2:
            confirm2 = await _recv(ws2, timeout=5)
            assert confirm2["status"] == "ok"

            attach2_resp = await _attach_shell(ws2, cn_id, shell_id_after, conn_id_2)
            content2 = attach2_resp.get("content", {})
            assert isinstance(content2, dict) and content2.get("status") == "reattached", (
                f"Expected reattached on recovered shell, got: {attach2_resp}"
            )

            # ── Phase 9: PTY is interactive ────────────────────────────────
            # Wait for Claude to start (up to 30s)
            recovery_output = await _collect_pty_output(ws2, keyword=None, max_msgs=80, per_msg_timeout=2.0)
            assert len(recovery_output) > 0, (
                "No PTY output after recovery — Claude Code may not have resumed"
            )

            # Echo test confirms PTY is interactive
            echo_token = f"recovered_{uuid.uuid4().hex[:8]}"
            await _send_pty_input(ws2, cn_id, shell_id_after, f"echo {echo_token}\r")
            echo_output = await _collect_pty_output(ws2, keyword=echo_token, max_msgs=40, per_msg_timeout=3.0)
            assert echo_token in echo_output, (
                f"Echo token not found after recovery.\n"
                f"Token: {echo_token!r}\n"
                f"Output: {echo_output!r}"
            )

    finally:
        new_srv.terminate()
        try:
            new_srv.wait(timeout=5)
        except subprocess.TimeoutExpired:
            new_srv.kill()
            new_srv.wait(timeout=3)


# ---------------------------------------------------------------------------
# Scenario C — Ghost-running detection
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(60)
async def test_proc_state_is_stale_after_restart(recovery_server):
    """After server restart, process.state.status still shows 'running' (stale).

    This is the signal gap: without WS push or is_active TTL check, the
    frontend has no way to know Claude died.  Test documents the pre-recovery
    state so the gap is explicit.

    Mirrors TypeScript ghost-running test:
      process.state = running + process.is_active = false → resolvedStatus = idle
    """
    port, base_url, db_path, srv_proc = recovery_server
    conn_id = str(uuid.uuid4())

    async with httpx.AsyncClient(base_url=base_url, timeout=20.0) as http:
        resp = await http.get("/api/v1/graph/bootstrap")
        cn_id = resp.json()["data"]["default_compute_node"]["id"]

        proc_resp = await http.post(
            "/api/v1/graph/agentic_process",
            json={"compute_node_id": f"compute_node-{cn_id}"},
        )
        process_id = proc_resp.json()["data"]["id"]

        open_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
        assert open_resp.json()["status"] == "SUCCESS", open_resp.text
        shell_id = open_resp.json()["data"]["shell_id"]

        # Confirm it's running
        proc_before = (await http.get(f"/api/v1/graph/agentic_process/{process_id}")).json()["data"]
        assert proc_before["state"]["status"] == "running", (
            "Process must be 'running' before server kill"
        )

    # Kill server
    srv_proc.kill()
    srv_proc.wait(timeout=5)

    # Restart
    new_srv = _start_server(port, db_path)
    try:
        await _wait_for_server(base_url, timeout=30.0)

        async with httpx.AsyncClient(base_url=base_url, timeout=20.0) as http:
            await http.get("/api/v1/graph/bootstrap")  # idempotent

            # Read process — state is stale (still "running" from pre-kill DB write)
            proc_after = (await http.get(f"/api/v1/graph/agentic_process/{process_id}")).json()["data"]
            stale_status = proc_after["state"]["status"]

            # Document the gap: entity says running but PTY is dead
            # is_active should be false (not persisted in DB — resets on next WS push)
            assert stale_status == "running", (
                f"Expected stale 'running' state after restart, got {stale_status!r}.\n"
                "If this fails, the server is already correcting ghost state on restart."
            )

            # open() is the correct recovery path — it detects dead PTY
            open2 = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
            assert open2.json()["status"] == "SUCCESS", (
                f"open() failed after ghost-running state: {open2.text}"
            )
            assert open2.json()["data"]["is_resume"] is True

    finally:
        new_srv.terminate()
        try:
            new_srv.wait(timeout=5)
        except subprocess.TimeoutExpired:
            new_srv.kill()
            new_srv.wait(timeout=3)
