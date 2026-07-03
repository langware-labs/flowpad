"""Unit tests for Shell.is_alive / read / write and AgenticProcess interface.

No mocks. Tests that need a live PTY create a Shell with a random compute_node_id
and call shell.start() — no DB, no server, cross-platform.
"""

import asyncio
import uuid

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)


async def _poll(shell: Shell, keyword: bytes, timeout: float = 10.0) -> bytes:
    """Poll read() until keyword appears or timeout."""
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        out = await shell.read()
        if keyword in out:
            return out
        await asyncio.sleep(0.1)
    out = await shell.read()
    raise TimeoutError(f"{keyword!r} not found within {timeout}s. last output: {out[-200:]!r}")


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path, monkeypatch):
    """`set_default_records_data_root` rebinds only the lambda inside
    flow_sdk.fs_store.record. Modules that did `from … import
    get_default_records_data_root` keep their own binding, so monkeypatch
    those callsites too."""
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    import flow_sdk.builtin.shell as _shell_mod
    monkeypatch.setattr(
        _shell_mod, "get_default_records_data_root", lambda: tmp_path,
        raising=False,
    )
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def _shell(**kwargs) -> Shell:
    return Shell(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()), **kwargs)


# ---------------------------------------------------------------------------
# Shell.is_alive
# ---------------------------------------------------------------------------

def test_shell_not_alive_when_no_compute_node_id():
    """is_alive is False when compute_node_id is not set."""
    shell = Shell(id=str(uuid.uuid4()))
    assert shell.is_alive is False


def test_shell_not_alive_when_no_session():
    """is_alive is False when no PTY session has been started."""
    assert _shell().is_alive is False


@pytest.mark.asyncio
async def test_shell_alive_after_start():
    """is_alive is True after start() starts a real OS PTY."""
    shell = _shell()
    try:
        await shell.start()
        assert shell.is_alive is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_shell_pty_kill_marks_not_alive():
    """get_pty().kill() kills the OS PTY — shell.is_alive is False afterwards."""
    shell = _shell()
    await shell.start()
    assert shell.is_alive is True

    pty = shell.compute_node.get_pty(shell.id)
    assert pty is not None
    await pty.kill()
    assert shell.is_alive is False


# ---------------------------------------------------------------------------
# Shell.read
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_read_empty_when_no_file():
    """read returns b'' when the .pty stream file does not exist."""
    shell = _shell()
    shell.pty_pid = shell.id
    assert await shell.read() == b""


@pytest.mark.asyncio
async def test_shell_read_returns_file_bytes(tmp_path):
    """read returns the exact bytes written to the .pty stream file."""
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.builtin.shell import shell_pty_stream_path

    shell = _shell()
    shell.pty_pid = shell.id

    record = FSRecord(type="shell", id=shell.id, pty_pid=shell.id)
    record.save()
    pty_path = shell_pty_stream_path(record.id, shell.id)
    pty_path.parent.mkdir(parents=True, exist_ok=True)
    pty_path.write_bytes(b"hello\r\nworld\r\n")

    assert await shell.read() == b"hello\r\nworld\r\n"


# ---------------------------------------------------------------------------
# AgenticProcess
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_proc_get_shell_returns_none_when_no_shell_id():
    from flow_sdk.builtin.agentic_process import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()))
    assert await proc.shell() is None


@pytest.mark.asyncio
async def test_proc_send_raises_when_no_shell():
    from flow_sdk.builtin.agentic_process import AgenticProcess

    proc = AgenticProcess(id=str(uuid.uuid4()))
    with pytest.raises(ValueError, match="No shell linked"):
        await proc.send("hello")


# ---------------------------------------------------------------------------
# Shell.write + read
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_shell_write_and_read():
    """start → write → read returns the echoed output."""
    shell = _shell()
    await shell.start()
    assert shell.is_alive

    try:
        await shell.write("echo hi")
        out = await _poll(shell, b"hi")
        assert b"hi" in out
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_shell_survives_kill_and_reopen():
    """kill() evicts in-memory state; start() spawns a fresh PTY on the same stream file."""
    shell = _shell()
    await shell.start()

    try:
        await shell.write("echo hi")
        await _poll(shell, b"hi")

        pty = shell.compute_node.get_pty(shell.id)
        await pty.kill()
        assert not shell.is_alive

        await shell.start()
        assert shell.is_alive

        await shell.write("echo hi_after_restart")
        await _poll(shell, b"hi_after_restart")

        full = await shell.read()
        assert full.count(b"hi") >= 2
        assert b"hi_after_restart" in full
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


# ---------------------------------------------------------------------------
# Shell.start_pty concurrency (per-shell lock)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_start_pty_on_dead_shell_creates_exactly_one_pty():
    """Two concurrent start_pty() on a shell whose PTY is dead must create EXACTLY
    ONE PTY — the per-shell lock serializes the watchdog recovery tick vs a
    concurrent client open. Without it both calls slip past the liveness check and
    each create_pty(), leaking a second OS PTY.

    ``start_pty`` returns True iff it spawned a fresh PTY, so exactly one True is
    the direct "one PTY created" signal. Pre-fix both race to True.
    """
    shell = _shell()
    await shell.start()

    # Crash the PTY but leave the row RUNNING — the post-restart / dead-worker
    # state both recovery entry points contend on.
    pty = shell.compute_node.get_pty(shell.id)
    await pty.kill()
    assert not shell.is_alive
    assert shell.status == "running"

    try:
        results = await asyncio.gather(shell.start_pty(), shell.start_pty())
        assert results.count(True) == 1, (
            f"expected exactly one start_pty() to spawn a PTY, got {results}"
        )
        assert shell.is_alive
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()
