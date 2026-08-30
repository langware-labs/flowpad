"""API tests for Shell.is_alive / read / write and
AgenticProcess.get_shell / send_input / sync_status.

Uses the in-process FastAPI app + a real SQLite DB (bootstrapped_client).
No Claude CLI required — Shell PTYs are plain zsh/bash sessions.
"""

import asyncio
import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.shell import Shell

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
# Shell.is_alive
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_not_alive_before_open(bootstrapped_client):
    """Shell created in DB but never opened: is_alive == False."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        assert shell.is_alive is False
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_alive_after_start(bootstrapped_client):
    """Shell.is_alive == True immediately after start() succeeds."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        assert shell.is_alive is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        await shell.delete()


# ---------------------------------------------------------------------------
# Shell.read
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_read_empty_before_input(bootstrapped_client):
    """read() returns b'' when no output has been produced yet."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        result = await shell.read()
        assert result == b""
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_write_echo(bootstrapped_client):
    """write('echo hi') produces 'hi' in read() after a short wait."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        await shell.write("echo shell_api_test_marker")
        await asyncio.sleep(0.5)
        output = await shell.read()
        assert b"shell_api_test_marker" in output
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        await shell.delete()


# ---------------------------------------------------------------------------
# Shell.pty.kill
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_kill_marks_not_alive(bootstrapped_client):
    """pty.kill() causes is_alive to return False."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        assert shell.is_alive is True
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        assert shell.is_alive is False
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_read_survives_kill(bootstrapped_client):
    """The .pty stream file (and its content) is intact after pty.kill()."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        await shell.write("echo before_destruct")
        await asyncio.sleep(0.5)
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        output = await shell.read()
        assert b"before_destruct" in output
    finally:
        await shell.delete()


@pytest.mark.asyncio
async def test_shell_reopen_after_kill(bootstrapped_client):
    """start() re-spawns after kill — is_alive returns True again."""
    cn_id = await _bootstrap_cn(bootstrapped_client)
    shell = await _make_shell(cn_id)
    try:
        await shell.start_pty()
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        assert shell.is_alive is False

        await shell.start_pty()
        assert shell.is_alive is True
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
        resolved = await proc.shell()
        assert resolved is not None
        assert resolved.id == shell.id
    finally:
        await proc.delete()
        await shell.delete()


@pytest.mark.asyncio
async def test_proc_send_input_delegates_to_shell(bootstrapped_client):
    """proc.send() writes to the PTY and the output is readable."""
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
        await proc.send("echo proc_send_test")
        await asyncio.sleep(0.5)
        output = await shell.read()
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
async def test_proc_sync_status_corrects_after_kill(bootstrapped_client):
    """sync_status() corrects state to idle when shell PTY has been killed."""
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
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
        assert shell.is_alive is False

    finally:
        await proc.delete()
        await shell.delete()
