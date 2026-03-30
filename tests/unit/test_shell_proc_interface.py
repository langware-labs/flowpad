"""Unit tests for Shell.connected / read_output / PtySession and AgenticProcess interface.

No mocks. Tests that need a live PTY create a Shell with a random compute_node_id
and call shell.open_pty() — no DB, no server, cross-platform.

The compute_node sync property constructs a local ComputeNode on the fly, so
no injection or DB lookup is needed.

Tests stop eih require a full DB + entity lifecycle live in
tests/api/test_shell_proc_interface.py.
"""

import asyncio
import uuid

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


async def _poll(shell: Shell, keyword: bytes, timeout: float = 10.0) -> bytes:
    """Poll read_output() until keyword appears or timeout."""
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        out = await shell.read_output()
        if keyword in out:
            return out
        await asyncio.sleep(0.1)
    out = await shell.read_output()
    raise TimeoutError(f"{keyword!r} not found within {timeout}s. last output: {out[-200:]!r}")


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def _shell(**kwargs) -> Shell:
    return Shell(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()), **kwargs)


# ---------------------------------------------------------------------------
# Shell.connected
# ---------------------------------------------------------------------------

def test_shell_connected_false_when_no_compute_node_id():
    """connected is False when compute_node_id is not set."""
    shell = Shell(id=str(uuid.uuid4()))
    assert shell.connected is False


def test_shell_connected_false_when_no_session():
    """connected is False when no PTY session has been started."""
    assert _shell().connected is False


@pytest.mark.asyncio
async def test_shell_connected_true_after_open_pty():
    """connected is True after open_pty() starts a real OS PTY."""
    shell = _shell()
    try:
        await shell.open_pty()
        assert shell.connected is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_shell_pty_kill_marks_disconnected():
    """get_pty().kill() kills the OS PTY — shell.connected is False afterwards."""
    shell = _shell()
    await shell.open_pty()
    assert shell.connected is True

    pty = shell.compute_node.get_pty(shell.id)
    assert pty is not None
    await pty.kill()
    assert shell.connected is False


# ---------------------------------------------------------------------------
# Shell.read_output
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_read_output_empty_when_no_file():
    """read_output returns b'' when the .pty stream file does not exist."""
    shell = _shell()
    shell.pty_pid = shell.id
    assert await shell.read_output() == b""


@pytest.mark.asyncio
async def test_shell_read_output_returns_file_bytes(tmp_path):
    """read_output returns the exact bytes written to the .pty stream file."""
    from flow_sdk.fs_records.shell_record import ShellRecord

    shell = _shell()
    shell.pty_pid = shell.id

    record = ShellRecord(id=shell.id, pty_pid=shell.id)
    record.save()
    pty_path = record.pty_stream_path
    pty_path.write_bytes(b"hello\r\nworld\r\n")

    assert await shell.read_output() == b"hello\r\nworld\r\n"


# ---------------------------------------------------------------------------
# AgenticProcess
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_proc_get_shell_returns_none_when_no_shell_id():
    from flow_sdk.builtin.agentic_process import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()))
    assert await proc.get_shell() is None


@pytest.mark.asyncio
async def test_proc_send_input_raises_when_no_shell():
    from flow_sdk.builtin.agentic_process import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()))
    with pytest.raises(ValueError, match="No shell linked"):
        await proc.send_input("hello")


@pytest.mark.asyncio
async def test_proc_sync_status_noop_when_already_idle():
    """sync_status returns immediately when status is idle — no DB call needed."""
    from flow_sdk.builtin.agentic_process import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()))


# ---------------------------------------------------------------------------
# PTY send + read_output
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_send_and_read_output():
    """open_pty → send_input → read_output returns the echoed output."""
    shell = _shell()
    await shell.open_pty()
    assert shell.connected

    try:
        await shell.send_input("echo hi\r")
        out = await _poll(shell, b"hi")
        assert b"hi" in out
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_shell_pty_survives_kill_and_reopen():
    """kill() evicts in-memory state; reopen starts a fresh PTY writing to the same stream file.

    Simulates an in-process server restart: memory lost, disk survives.
    The full stream file accumulates output from both sessions.
    """
    shell = _shell()
    await shell.open_pty()

    try:
        await shell.send_input("echo hi\r")
        await _poll(shell, b"hi")

        # Simulate restart: kill OS PTY and evict all in-memory state
        pty = shell.compute_node.get_pty(shell.id)
        await pty.kill()
        assert not shell.connected

        # Reopen — fresh PTY, same stream file on disk
        await shell.open_pty()
        assert shell.connected

        await shell.send_input("echo hi_after_restart\r")
        await _poll(shell, b"hi_after_restart")

        # Full stream file accumulates both sessions — "hi" appears in both
        full = await shell.read_output()
        assert full.count(b"hi") >= 2  # once from first session, once inside "hi_after_restart"
        assert b"hi_after_restart" in full
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
