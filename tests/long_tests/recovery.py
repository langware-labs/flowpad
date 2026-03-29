"""E2E recovery tests — AgenticProcess + Shell after server restart.

Mirrors the TypeScript agentic_process_stress.test.ts PTY lifecycle and
restore-from-DB suites.  Uses pure Python object calls instead of WebSocket
for assertions — Shell.connected, Shell.read_output(), Shell.pty.destruct(),
AgenticProcess.get_shell(), AgenticProcess.sync_status().

Scenario A: PTY lifecycle
  1. Create AgenticProcess via HTTP
  2. open() via HTTP → shell_id + worker_session_id
  3. Load Shell entity, hydrate provider
  4. assert shell.connected
  5. Poll read_output() until Claude startup output appears
  6. proc.send_input('echo hello_claude') via object call
  7. Poll read_output() for echo token

Scenario B: PTY destruct + sync_status
  1. Same as A (Claude running)
  2. shell.pty.destruct() — simulates in-process server crash (kills OS PTY)
  3. assert not shell.connected
  4. proc.sync_status() corrects state to idle
  5. Re-open via HTTP → is_resume=True
  6. Echo test on recovered shell

Scenario C: Full server-restart recovery (kill/restart)
  1. Same as A (Claude running)
  2. SIGKILL the server process
  3. Restart server with same DB
  4. GET process → state still "running" (stale)
  5. open() → is_resume=True, new shell_id
  6. Load new Shell, verify connected
  7. Echo test confirms PTY interactive

These tests require:
  - DEEP_TESTING=true
  - `claude` CLI in PATH (for Claude Code PTY)
  - Network access for the Claude model
"""

import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid

import httpx
import pytest

from tests.test_settings import test_service_config

pytestmark = pytest.mark.skipif(
    not test_service_config.deep_testing,
    reason="Skipping long tests when DEEP_TESTING is disabled",
)


# ---------------------------------------------------------------------------
# Server fixture helpers
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
# Object-level helpers
# ---------------------------------------------------------------------------

async def _load_shell(shell_id: str, db_path: str):
    """Load a Shell entity from the shared DB."""
    import flow_sdk.db.database as db_mod
    os.environ["SQLITE_DATABASE_PATH"] = db_path
    db_mod._engine = None
    db_mod._session_factory = None

    from flow_sdk.builtin.shell import Shell
    shell = await Shell.get_by_id(shell_id)
    assert shell is not None, f"Shell {shell_id} not found in DB"
    return shell


async def _poll_output(shell, keyword: bytes, timeout: float = 30.0) -> bytes:
    """Poll shell.read_output() until keyword appears or timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        output = await shell.read_output()
        if keyword in output:
            return output
        await asyncio.sleep(0.5)
    output = await shell.read_output()
    raise TimeoutError(
        f"Keyword {keyword!r} not found in PTY output within {timeout}s.\n"
        f"Last output ({len(output)} bytes): {output[-500:]!r}"
    )


# ---------------------------------------------------------------------------
# Scenario A — PTY lifecycle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(120)
async def test_proc_pty_lifecycle(recovery_server):
    """Create process, open(), verify Claude starts, echo test via object calls.

    Mirrors TypeScript Suite 1 — PTY lifecycle.
    """
    port, base_url, db_path, _srv = recovery_server

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
        open_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
        assert open_resp.status_code == 200, open_resp.text
        open_data = open_resp.json()["data"]
        shell_id = open_data["shell_id"]
        worker_session_id = open_data["worker_session_id"]
        assert shell_id, "open() must return a shell_id"
        assert worker_session_id, "open() must return a worker_session_id"

    # Load Shell entity directly and check liveness
    shell = await _load_shell(shell_id, db_path)
    assert shell.connected, "Shell must be connected immediately after open()"

    # Wait for Claude to emit startup output
    await _poll_output(shell, b"", timeout=30.0)  # any output = Claude started
    output = await shell.read_output()
    assert len(output) > 0, "PTY produced no output — Claude Code may not have started"

    # Echo test via proc.send_input()
    from flow_sdk.builtin.agentic_process import AgenticProcess
    proc = await AgenticProcess.get_by_id(process_id)
    assert proc is not None

    echo_token = f"hello_claude_{uuid.uuid4().hex[:8]}".encode()
    await proc.send_input(f"echo {echo_token.decode()}")

    output = await _poll_output(shell, echo_token, timeout=30.0)
    assert echo_token in output, f"Echo token {echo_token!r} not found in output"


# ---------------------------------------------------------------------------
# Scenario B — PTY destruct + sync_status
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(120)
async def test_proc_recovery_after_destruct(recovery_server):
    """destruct() kills PTY; sync_status() corrects to idle; re-open resumes.

    Mirrors TypeScript ghost-running + recovery test.
    Uses shell.pty.destruct() instead of server SIGKILL — faster and
    targeted at the specific PTY process without restarting the server.
    """
    port, base_url, db_path, _srv = recovery_server

    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
        resp = await http.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"
        cn_id = resp.json()["data"]["default_compute_node"]["id"]

        proc_resp = await http.post(
            "/api/v1/graph/agentic_process",
            json={"compute_node_id": f"compute_node-{cn_id}"},
        )
        assert proc_resp.status_code == 200, proc_resp.text
        process_id = proc_resp.json()["data"]["id"]

        open_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
        assert open_resp.status_code == 200, open_resp.text
        shell_id = open_resp.json()["data"]["shell_id"]
        worker_session_id = open_resp.json()["data"]["worker_session_id"]

    # Phase 1: Verify Claude is running
    shell = await _load_shell(shell_id, db_path)
    assert shell.connected, "Shell must be connected after open()"
    await _poll_output(shell, b"", timeout=30.0)  # wait for Claude startup

    # Phase 2: Kill PTY — kills OS PTY, clears in-memory session
    pty = shell.compute_node.get_pty(shell.id)
    assert pty is not None, "PTY session must exist after open()"
    await pty.kill()
    assert not shell.connected, "Shell must not be connected after pty.kill()"

    # Phase 3: sync_status() corrects state to idle (in test process via shared DB)
    from flow_sdk.builtin.agentic_process import AgenticProcess
    proc = await AgenticProcess.get_by_id(process_id)
    assert proc is not None
    proc._set_process_state(status="running")  # simulate ghost state
    await proc.sync_status()
    assert proc._get_process_state()["status"] == "idle", (
        "sync_status() must correct ghost-running state to idle"
    )

    # Phase 4: Re-open via HTTP → is_resume=True
    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
        open2_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
        assert open2_resp.status_code == 200, open2_resp.text
        open2_data = open2_resp.json()["data"]

    shell_id_2 = open2_data["shell_id"]
    is_resume = open2_data.get("is_resume", False)
    assert is_resume is True, f"open() after destruct must resume: is_resume=True, got {open2_data}"
    assert open2_data["worker_session_id"] == worker_session_id, (
        "worker_session_id must be preserved through recovery"
    )

    # Phase 5: New shell is connected and interactive
    shell2 = await _load_shell(shell_id_2, db_path)
    assert shell2.connected, "Recovered shell must be connected"

    echo_token = f"hello_after_recovery_{uuid.uuid4().hex[:8]}".encode()
    from flow_sdk.builtin.agentic_process import AgenticProcess as AP
    proc2 = await AP.get_by_id(process_id)
    await proc2.send_input(f"echo {echo_token.decode()}")

    output = await _poll_output(shell2, echo_token, timeout=30.0)
    assert echo_token in output, (
        f"Echo token {echo_token!r} not found after recovery.\n"
        f"Output: {output[-500:]!r}"
    )


# ---------------------------------------------------------------------------
# Scenario C — Full server-restart recovery (kill + restart server process)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(240)
async def test_proc_recovery_after_server_restart(recovery_server):
    """Full kill-restart recovery cycle.

    Mirrors TypeScript Suite 2 — Restore from DB.
    Uses object calls for Shell liveness / output checks; HTTP only for
    server actions (open, bootstrap).
    """
    port, base_url, db_path, srv_proc = recovery_server

    async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
        resp = await http.get("/api/v1/graph/bootstrap")
        assert resp.status_code == 200, f"Bootstrap failed: {resp.text}"
        cn_id = resp.json()["data"]["default_compute_node"]["id"]

        proc_resp = await http.post(
            "/api/v1/graph/agentic_process",
            json={"compute_node_id": f"compute_node-{cn_id}"},
        )
        assert proc_resp.status_code == 200, proc_resp.text
        process_id = proc_resp.json()["data"]["id"]

        open_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
        assert open_resp.status_code == 200, open_resp.text
        open_data = open_resp.json()["data"]
        shell_id_before = open_data["shell_id"]
        worker_session_id = open_data["worker_session_id"]

    # Verify Claude started
    shell_before = await _load_shell(shell_id_before, db_path)
    assert shell_before.connected
    await _poll_output(shell_before, b"", timeout=30.0)

    # SIGKILL the server — simulates crash
    srv_proc.kill()
    srv_proc.wait(timeout=5)

    # After kill: OS PTY processes are also dead
    assert not shell_before.connected, "Shell must not be connected after server SIGKILL"

    # Restart server with same DB
    new_srv = _start_server(port, db_path)
    try:
        await _wait_for_server(base_url, timeout=30.0)

        async with httpx.AsyncClient(base_url=base_url, timeout=30.0) as http:
            await http.get("/api/v1/graph/bootstrap")  # idempotent

            # Process still in DB, state "running" (stale — no correction yet)
            proc_get = await http.get(f"/api/v1/graph/agentic_process/{process_id}")
            assert proc_get.status_code == 200, f"Process not found: {proc_get.text}"
            proc_data = proc_get.json()["data"]
            assert proc_data["worker_session_id"] == worker_session_id

            # open() detects dead PTY and resumes Claude
            open2_resp = await http.post(f"/api/v1/graph/agentic_process/{process_id}/open")
            assert open2_resp.status_code == 200, f"open() after restart failed: {open2_resp.text}"
            open2_data = open2_resp.json()["data"]

        shell_id_after = open2_data["shell_id"]
        is_resume = open2_data.get("is_resume", False)
        assert shell_id_after, "open() after restart must return shell_id"
        assert is_resume is True, (
            f"open() after restart must resume Claude session (is_resume=True). Got: {open2_data}"
        )
        assert open2_data["worker_session_id"] == worker_session_id, (
            "worker_session_id must be preserved through restart"
        )

        # New shell is connected and interactive
        shell_after = await _load_shell(shell_id_after, db_path)
        assert shell_after.connected, "Recovered shell must be connected after restart"

        await _poll_output(shell_after, b"", timeout=30.0)

        echo_token = f"recovered_{uuid.uuid4().hex[:8]}".encode()
        from flow_sdk.builtin.agentic_process import AgenticProcess
        proc = await AgenticProcess.get_by_id(process_id)
        await proc.send_input(f"echo {echo_token.decode()}")

        output = await _poll_output(shell_after, echo_token, timeout=30.0)
        assert echo_token in output, (
            f"Echo token not found after server restart.\n"
            f"Token: {echo_token!r}\nOutput: {output[-500:]!r}"
        )

    finally:
        new_srv.terminate()
        try:
            new_srv.wait(timeout=5)
        except subprocess.TimeoutExpired:
            new_srv.kill()
            new_srv.wait(timeout=3)


# ---------------------------------------------------------------------------
# Scenario D — pure object-level: prompt → kill PTY → re-open recovers context
# No HTTP. No server. Direct object calls only.
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.timeout(120)
async def test_agentic_process_recovery_no_http(tmp_path):
    """AgenticProcess: open → prompt → kill PTY → re-open recalls prior context.

    Zero HTTP. Uses the @local ComputeNode directly.
    The ClaudeSessionRecord written to disk during the first session is the
    recovery anchor — open() detects the dead PTY and passes --resume to Claude.
    """
    from flow_sdk.db.database import init_db
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.fs_records.claude.claude_session import ClaudeSessionRecord
    from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
    from flow_sdk.server.routes.bootstrap import get_or_create_local_compute_node

    await init_db()
    cn = await get_or_create_local_compute_node()
    workdir = str(tmp_path / "workdir")
    os.makedirs(workdir, exist_ok=True)

    original_root = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    try:
        proc = AgenticProcess(compute_node_id=str(cn.typeid), workdir=workdir)
        await proc.save()

        # Phase 1: open fresh, send prompt
        await proc.open()
        assert proc.shell_id is not None, "open() must set shell_id"

        # open() returns once Claude's PID is found, but Claude still needs ~2s
        # to finish rendering its startup screen before it can accept input.
        await asyncio.sleep(3)
        await proc.send_input("Remember the number 3422455")

        # Wait up to 30s for Claude to write the session transcript to disk.
        # The transcript file is the recovery anchor for --resume.
        worker_session_id = proc.worker_session_id
        deadline = time.monotonic() + 30.0
        session_rec = None
        while time.monotonic() < deadline:
            session_rec = ClaudeSessionRecord.discover_one(worker_session_id)
            if session_rec:
                break
            await asyncio.sleep(0.5)
        assert session_rec is not None, (
            f"ClaudeSessionRecord not found after 30s for session {worker_session_id}. "
            "Claude must write the transcript before recovery is possible."
        )

        # Phase 2: kill PTY — evicts RAM, disk (transcript + stream file) survives
        shell = await proc.get_shell()
        pty = shell.compute_node.get_pty(shell.id)
        assert pty is not None, "PTY must be alive after open()"
        await pty.kill()
        assert not shell.connected, "Shell must be disconnected after pty.kill()"

        # Phase 3: re-open — detects dead PTY, finds ClaudeSessionRecord → --resume
        await proc.open()
        assert proc.shell_id is not None, "re-open() must set shell_id"

        await proc.send_input("What is the number I told you to remember? Reply with just the number.")

        # Phase 4: Claude resumes with full context and recalls the number
        shell2 = await proc.get_shell()
        output = await _poll_output(shell2, b"3422455", timeout=30.0)
        assert b"3422455" in output, (
            f"Claude did not recall the number after recovery.\nOutput: {output[-500:]!r}"
        )
    finally:
        set_default_records_root(original_root)
