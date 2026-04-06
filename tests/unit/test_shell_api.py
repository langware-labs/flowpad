"""Unit tests for the Shell layer API.

Tests Shell.is_alive, write(), write_raw(), read(), output(), stop(),
restart(), rename(), set_env(), active(), and open() classmethod.
Uses real PTYs (no mocks) for integration paths; mocks only where
no real PTY is needed.
"""

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.fs_store.record import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def _shell(**kwargs) -> Shell:
    return Shell(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()), **kwargs)


async def _poll(shell: Shell, keyword: bytes, timeout: float = 10.0) -> bytes:
    import time
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        out = await shell.read()
        if keyword in out:
            return out
        await asyncio.sleep(0.1)
    out = await shell.read()
    raise TimeoutError(f"{keyword!r} not found within {timeout}s. last: {out[-200:]!r}")


# ---------------------------------------------------------------------------
# is_alive
# ---------------------------------------------------------------------------

def test_is_alive_false_without_compute_node_id():
    """is_alive is False when compute_node_id is not set."""
    shell = Shell(id=str(uuid.uuid4()))
    assert shell.is_alive is False


def test_is_alive_false_when_no_session():
    """is_alive is False before start() is called."""
    assert _shell().is_alive is False


@pytest.mark.asyncio
async def test_is_alive_true_after_start():
    """is_alive is True after start() spawns an OS PTY."""
    shell = _shell()
    try:
        await shell.start()
        assert shell.is_alive is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


# ---------------------------------------------------------------------------
# pty property
# ---------------------------------------------------------------------------

def test_pty_property_returns_none_before_start():
    """shell.pty is None before start()."""
    assert _shell().pty is None


@pytest.mark.asyncio
async def test_pty_property_returns_handle_after_start():
    """shell.pty returns a live Pty handle after start()."""
    shell = _shell()
    try:
        await shell.start()
        assert shell.pty is not None
        assert shell.pty.is_alive
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


# ---------------------------------------------------------------------------
# start() — idempotent
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_start_returns_true_on_first_call():
    """start() returns True when a new PTY is spawned."""
    shell = _shell()
    try:
        result = await shell.start()
        assert result is True
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_start_returns_false_when_already_alive():
    """start() returns False if the PTY is already running."""
    shell = _shell()
    try:
        await shell.start()
        assert shell.is_alive
        result = await shell.start()
        assert result is False
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


# ---------------------------------------------------------------------------
# stop() / restart()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_stop_kills_pty_and_sets_idle():
    """stop() kills the PTY and sets status='idle'."""
    shell = _shell()
    await shell.start()
    assert shell.is_alive
    await shell.stop()
    assert shell.is_alive is False
    assert shell.status == "idle"


@pytest.mark.asyncio
async def test_restart_respawns_pty():
    """restart() stops then starts — shell is alive again afterwards."""
    shell = _shell()
    await shell.start()
    assert shell.is_alive
    await shell.restart()
    assert shell.is_alive
    # cleanup
    pty = shell.compute_node.get_pty(shell.id)
    if pty:
        await pty.kill()


# ---------------------------------------------------------------------------
# write() / write_raw() / read()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_write_raises_when_no_pty():
    """write() raises RuntimeError when PTY is not started."""
    shell = _shell()
    with pytest.raises(RuntimeError, match="No PTY session"):
        await shell.write("hello")


@pytest.mark.asyncio
async def test_write_raw_raises_when_no_pty():
    """write_raw() raises RuntimeError when PTY is not started."""
    shell = _shell()
    with pytest.raises(RuntimeError, match="No PTY session"):
        await shell.write_raw(b"\x03")


@pytest.mark.asyncio
async def test_read_returns_empty_bytes_when_no_record():
    """read() returns b'' when no pty stream file exists."""
    shell = _shell()
    shell.pty_pid = shell.id
    result = await shell.read()
    assert result == b""


@pytest.mark.asyncio
async def test_write_echo_visible_in_read():
    """write('echo X') → X appears in read() output."""
    shell = _shell()
    await shell.start()
    try:
        await shell.write("echo shell_api_unit_marker")
        out = await _poll(shell, b"shell_api_unit_marker")
        assert b"shell_api_unit_marker" in out
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_write_bracketed_paste_in_output():
    """write() uses bracketed paste — the text appears in PTY output intact."""
    shell = _shell()
    await shell.start()
    try:
        # The bracketed-paste markers are consumed by the shell; the text is echoed as-is.
        await shell.write("echo bracketed_paste_check")
        out = await _poll(shell, b"bracketed_paste_check")
        assert b"bracketed_paste_check" in out
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


# ---------------------------------------------------------------------------
# output() — live stream
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_output_yields_bytes():
    """output() yields bytes produced by the PTY."""
    shell = _shell()
    await shell.start()
    try:
        collected: list[bytes] = []

        async def _collect():
            async for chunk in shell.output():
                collected.append(chunk)
                if b"output_stream_test" in b"".join(collected):
                    break

        await shell.write("echo output_stream_test")
        task = asyncio.create_task(_collect())
        await asyncio.wait_for(task, timeout=10.0)
        assert b"output_stream_test" in b"".join(collected)
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


@pytest.mark.asyncio
async def test_output_returns_empty_iterator_when_no_pty():
    """output() returns an empty async iterator when no PTY is active."""
    shell = _shell()
    chunks = []
    async for chunk in shell.output():
        chunks.append(chunk)
    assert chunks == []


# ---------------------------------------------------------------------------
# rename() / set_env()
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_rename_sets_name_and_user_renamed():
    """rename() updates shell.name and sets user_renamed=True."""
    shell = _shell()
    await shell.rename("My Tab")
    assert shell.name == "My Tab"
    assert shell.user_renamed is True


@pytest.mark.asyncio
async def test_set_env_persists_vars():
    """set_env() stores vars in shell.env."""
    shell = _shell()
    await shell.set_env(FOO="bar", BAZ="qux")
    assert shell.env == {"FOO": "bar", "BAZ": "qux"}


@pytest.mark.asyncio
async def test_set_env_merges_with_existing():
    """set_env() merges with previously set vars."""
    shell = _shell()
    await shell.set_env(A="1")
    await shell.set_env(B="2")
    assert shell.env == {"A": "1", "B": "2"}


# ---------------------------------------------------------------------------
# active() classmethod
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_active_excludes_closed_shells():
    """active() omits shells with status='closed'."""
    running = Shell(id=str(uuid.uuid4()), status="running", tab_order=1)
    await running.save()
    closed = Shell(id=str(uuid.uuid4()), status="closed", tab_order=0)
    await closed.save()

    active = await Shell.active()
    ids = [s.id for s in active]
    assert running.id in ids
    assert closed.id not in ids


@pytest.mark.asyncio
async def test_active_ordered_by_tab_order():
    """active() shells are in ascending tab_order."""
    s2 = Shell(id=str(uuid.uuid4()), status="running", tab_order=2)
    await s2.save()
    s1 = Shell(id=str(uuid.uuid4()), status="running", tab_order=1)
    await s1.save()
    s0 = Shell(id=str(uuid.uuid4()), status="running", tab_order=0)
    await s0.save()

    active = await Shell.active()
    orders = [s.tab_order for s in active]
    assert orders == sorted(orders)


# ---------------------------------------------------------------------------
# Shell.open() classmethod
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_open_classmethod_returns_alive_shell():
    """Shell.open() creates and starts a PTY — shell.is_alive is True."""
    cn_id = str(uuid.uuid4())
    shell = await Shell.open(compute_node_id=cn_id)
    try:
        assert shell.is_alive is True
        assert shell.status == "running"
    finally:
        pty = shell.compute_node.get_pty(shell.id)
        if pty:
            await pty.kill()


# ---------------------------------------------------------------------------
# Context manager
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_context_manager_starts_and_closes():
    """async with Shell(...) as shell → started on enter, closed on exit."""
    cn_id = str(uuid.uuid4())
    shell_id = str(uuid.uuid4())
    async with Shell(id=shell_id, compute_node_id=cn_id) as shell:
        assert shell.is_alive is True

    # After exit, close() was called — entity deleted from DB
    from flow_sdk.builtin.shell import Shell as S
    retrieved = await S.get_one({"id": shell_id})
    assert retrieved is None
