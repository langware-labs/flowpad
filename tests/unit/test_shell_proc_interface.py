"""Unit tests for Shell.connected / read_output / PtySession and AgenticProcess interface.

No mocks. Tests that need a live PTY create a Shell with a random compute_node_id
and call shell.open_pty() — no DB, no server, cross-platform.

The compute_node sync property constructs a local ComputeNode on the fly, so
no injection or DB lookup is needed.

Tests that require a full DB + entity lifecycle live in
tests/api/test_shell_proc_interface.py.
"""

import uuid

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


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
    from flow_sdk.builtin.agentic_processor import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()))
    assert await proc.get_shell() is None


@pytest.mark.asyncio
async def test_proc_send_input_raises_when_no_shell():
    from flow_sdk.builtin.agentic_processor import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()))
    with pytest.raises(ValueError, match="No shell linked"):
        await proc.send_input("hello")


@pytest.mark.asyncio
async def test_proc_sync_status_noop_when_already_idle():
    """sync_status returns immediately when status is idle — no DB call needed."""
    from flow_sdk.builtin.agentic_processor import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()))
    proc._set_process_state(status="idle")
    await proc.sync_status()
    assert proc._get_process_state()["status"] == "idle"
