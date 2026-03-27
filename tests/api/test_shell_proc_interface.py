"""API tests for Shell.connected / read_output / pty.destruct and
AgenticProcess.get_shell / send_input / sync_status.

Uses the in-process FastAPI app + a real SQLite DB (bootstrapped_client).
No Claude CLI required — Shell PTYs are plain zsh/bash sessions.
"""

import asyncio
import uuid

import pytest

from flow_sdk.builtin.agentic_processor import AgenticProcess
from flow_sdk.builtin.shell import Shell
from flow_sdk.responses.response import ApiResponse


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _compute_node_id(bootstrap_resp) -> str:
    return bootstrap_resp.json()["data"]["default_compute_node"]["id"]


async def _bootstrap_cn(client) -> str:
    resp = await client.get("/api/v1/graph/bootstrap")
    assert resp.status_code == 200
    return _compute_node_id(resp)


async def _make_shell(cn_id: str) -> Shell:
    """Create a Shell entity in DB (not yet opened)."""
    shell = Shell(
        id=str(uuid.uuid4()),
        name="test-shell",
        compute_node_id=cn_id,
        status="idle",
    )
    await shell.save()
    return shell


# ---------------------------------------------------------------------------
# Shell.connected
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_not_connected_before_open(bootstrapped_client):
    """Shell created in DB but never opened: connected == False."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        assert shell.connected is False
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_connected_after_start_pty(bootstrapped_client):
    """Shell.connected == True immediately after start_pty() succeeds."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        assert shell.connected is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        await shell.delete()


# ---------------------------------------------------------------------------
# Shell.read_output
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_read_output_empty_before_input(bootstrapped_client):
    """read_output() returns b'' when no output has been produced yet (or before open)."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        result = await shell.read_output()
        assert result == b""
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_send_input_echo(bootstrapped_client):
    """send_input('echo hi') produces 'hi' in read_output() after a short wait."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        await shell.send_input("echo shell_api_test_marker")
        # Give the PTY time to run the command and flush to disk
        await asyncio.sleep(0.5)
        output = await shell.read_output()
        assert b"shell_api_test_marker" in output
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        await shell.delete()


# ---------------------------------------------------------------------------
# Shell.pty.destruct
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_destruct_kills_liveness(bootstrapped_client):
    """destruct() causes connected to return False."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        assert shell.connected is True
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        assert shell.connected is False
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_read_output_survives_destruct(bootstrapped_client):
    """The .pty stream file (and its content) is intact after destruct()."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        await shell.send_input("echo before_destruct")
        await asyncio.sleep(0.5)
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        # File still readable
        output = await shell.read_output()
        assert b"before_destruct" in output
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_reopen_after_destruct(bootstrapped_client):
    """start_pty() re-spawns and connected returns True after a prior destruct().

    After destruct(), shell.status is still 'running' in memory (just like after
    a server crash).  start_pty() detects the dead PTY, cleans up, and spawns a
    new one — this is the normal recovery path.
    """
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        assert shell.connected is False

        # Recovery path: start_pty() on a running-but-dead shell cleans up and respawns
        await shell.start_pty()
        assert shell.connected is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        await shell.delete()


# ---------------------------------------------------------------------------
# AgenticProcess.get_shell / send_input
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_proc_get_shell_returns_linked_shell(bootstrapped_client):
    """get_shell() returns the Shell entity whose id matches shell_id."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        compute_node_id=cn_id,
        shell_id=shell.id,
    )
    await proc.save()
    try:
        resolved = await proc.get_shell()
        assert resolved is not None
        assert resolved.id == shell.id
    finally:
        await proc.delete()
        await shell.delete()


@pytest.mark.asyncio
async def test_proc_send_input_delegates_to_shell(bootstrapped_client):
    """proc.send_input() writes to the PTY and the output is readable."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    await shell.start_pty()

    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        compute_node_id=cn_id,
        shell_id=shell.id,
    )
    await proc.save()
    try:
        await proc.send_input("echo proc_send_test")
        await asyncio.sleep(0.5)
        output = await shell.read_output()
        assert b"proc_send_test" in output
    finally:
        await proc.delete()
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        await shell.delete()


# ---------------------------------------------------------------------------
# AgenticProcess.sync_status
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_proc_sync_status_corrects_after_destruct(bootstrapped_client):
    """sync_status() corrects state to idle when shell PTY has been destructed."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    await shell.start_pty()

    proc = AgenticProcess(
        id=str(uuid.uuid4()),
        compute_node_id=cn_id,
        shell_id=shell.id,
    )
    proc._set_process_state(status="running")
    await proc.save()

    try:
        # Simulate server crash: kill PTY but leave state as "running"
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        assert shell.connected is False
        assert proc._get_process_state()["status"] == "running"

        # sync_status should correct the ghost-running state
        await proc.sync_status()
        assert proc._get_process_state()["status"] == "idle"
    finally:
        await proc.delete()
        await shell.delete()
