"""Unit tests for AgenticProcess and Shell lifecycle semantics.

Tests:
- process.exit()    — keeps shell entity alive (status=idle)
- process.close()   — deletes shell entity permanently
- process.restart() — shell_id preserved across exit + start
- shell.terminate_worker() — SIGTERM then SIGKILL on worker_pid
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers import get_driver
from flow_sdk.builtin.shell import Shell


def test_driver_preassign_interactive_session_id_flags():
    assert get_driver("claude").preassign_interactive_session_id is True
    assert get_driver("codex").preassign_interactive_session_id is False


# ---------------------------------------------------------------------------
# shell.terminate_worker
# ---------------------------------------------------------------------------


def _fake_psutil_proc(pid):
    """Build a MagicMock that behaves like a psutil.Process with no children."""
    proc = MagicMock()
    proc.pid = pid
    proc.children.return_value = []
    proc.terminate = MagicMock()
    proc.kill = MagicMock()
    return proc


@pytest.mark.asyncio
async def test_terminate_worker_no_pid():
    """terminate_worker() is a no-op when worker_pid is None."""
    shell = Shell.model_construct(worker_pid=None)
    await shell.terminate_worker()  # must not raise


@pytest.mark.asyncio
async def test_terminate_worker_already_gone():
    """terminate_worker() handles NoSuchProcess gracefully when psutil.Process raises."""
    import psutil

    shell = Shell.model_construct(worker_pid=99999)
    with patch("flow_sdk.builtin.shell.psutil.Process", side_effect=psutil.NoSuchProcess(99999)):
        await shell.terminate_worker()  # must not raise


@pytest.mark.asyncio
async def test_terminate_worker_sigterm_sufficient():
    """terminate_worker() calls psutil terminate(); if process exits quickly, no kill() sent."""
    proc = _fake_psutil_proc(12345)

    # wait_procs returns (gone, alive=[]) → no fallback kill
    async def fake_to_thread(fn, *args, **kwargs):
        return ([proc], [])

    with patch("flow_sdk.builtin.shell.psutil.Process", return_value=proc), \
         patch("flow_sdk.builtin.shell.asyncio.to_thread", side_effect=fake_to_thread):
        shell = Shell.model_construct(worker_pid=12345)
        await shell.terminate_worker()

    proc.terminate.assert_called_once()
    proc.kill.assert_not_called()


@pytest.mark.asyncio
async def test_terminate_worker_sigkill_fallback():
    """terminate_worker() falls back to .kill() when psutil.wait_procs reports survivors."""
    proc = _fake_psutil_proc(12345)
    call_count = {"n": 0}

    async def fake_to_thread(fn, victims, timeout, *args, **kwargs):
        call_count["n"] += 1
        # 1st wait: still alive → triggers kill()
        # 2nd wait (after kill): now gone
        if call_count["n"] == 1:
            return ([], [proc])
        return ([proc], [])

    with patch("flow_sdk.builtin.shell.psutil.Process", return_value=proc), \
         patch("flow_sdk.builtin.shell.asyncio.to_thread", side_effect=fake_to_thread):
        shell = Shell.model_construct(worker_pid=12345)
        await shell.terminate_worker()

    proc.terminate.assert_called_once()
    proc.kill.assert_called_once()


# ---------------------------------------------------------------------------
# AgenticProcess.exit() — keeps shell alive
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_exit_keeps_shell():
    """process.exit() preserves shell entity — calls stop(), NOT close()."""
    process = AgenticProcess.model_construct(
        id="proc-1",
        shell_id="shell-1",
        sidecar_shell_id=None,
        session_id="sess-abc",
        context_data={},
    )

    mock_shell = MagicMock()
    mock_shell.tab_order = 3
    mock_shell.terminate_worker = AsyncMock()
    mock_shell.stop = AsyncMock()
    mock_shell.close = AsyncMock()

    with patch("flow_sdk.builtin.shell.Shell.get_by_id", return_value=mock_shell), \
         patch.object(AgenticProcess, "save", new_callable=AsyncMock):
        from flow_sdk.responses.response import ApiSuccessResponse
        result = await process.exit()

    assert isinstance(result, ApiSuccessResponse)
    mock_shell.stop.assert_awaited_once()
    mock_shell.close.assert_not_awaited()
    mock_shell.terminate_worker.assert_awaited_once()
    # shell_id still set — shell entity is alive
    assert process.shell_id == "shell-1"


# ---------------------------------------------------------------------------
# AgenticProcess._http_close() — deletes shell
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_close_deletes_shell():
    """process._http_close() calls internal close() which deletes the shell entity."""
    process = AgenticProcess.model_construct(
        id="proc-2",
        shell_id="shell-2",
        sidecar_shell_id=None,
        context_data={},
    )

    mock_shell = MagicMock()
    mock_shell.close = AsyncMock()

    with patch("flow_sdk.builtin.shell.Shell.get_by_id", return_value=mock_shell), \
         patch.object(AgenticProcess, "save", new_callable=AsyncMock):
        from flow_sdk.responses.response import ApiSuccessResponse
        result = await process._http_close()

    assert isinstance(result, ApiSuccessResponse)
    mock_shell.close.assert_awaited_once()
    # shell_id cleared after permanent close
    assert process.shell_id is None


# ---------------------------------------------------------------------------
# AgenticProcess.http_restart() — shell_id preserved
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_restart_preserves_shell_id():
    """http_restart() calls exit() + start_pty(); shell entity survives so same shell_id reused."""
    process = AgenticProcess.model_construct(
        id="proc-3",
        shell_id="shell-3",
        sidecar_shell_id=None,
        session_id="sess-xyz",
        context_data={},
    )

    mock_shell = MagicMock()
    mock_shell.tab_order = 1
    mock_shell.terminate_worker = AsyncMock()
    mock_shell.stop = AsyncMock()

    from flow_sdk.responses.response import ApiSuccessResponse
    start_result = ApiSuccessResponse(data={"shell_id": "shell-3", "session_id": "sess-xyz"})

    with patch("flow_sdk.builtin.shell.Shell.get_by_id", return_value=mock_shell), \
         patch.object(AgenticProcess, "save", new_callable=AsyncMock), \
         patch.object(AgenticProcess, "start_pty", new_callable=AsyncMock, return_value=start_result):
        result = await process.http_restart()

    assert isinstance(result, ApiSuccessResponse)
    # shell entity survived exit — same shell_id going into start_pty()
    assert process.shell_id == "shell-3"
