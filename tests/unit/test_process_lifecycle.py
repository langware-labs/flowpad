"""Unit tests for AgenticProcess and Shell lifecycle semantics.

Tests:
- process.exit()    — keeps shell entity alive (status=idle)
- process.close()   — deletes shell entity permanently
- process.restart() — shell_id preserved across exit + start
- shell.terminate_worker() — SIGTERM then SIGKILL on worker_pid
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess


# ---------------------------------------------------------------------------
# shell.terminate_worker
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_terminate_worker_no_pid():
    """terminate_worker() is a no-op when worker_pid is None."""
    shell = Shell.model_construct(worker_pid=None)
    await shell.terminate_worker()  # must not raise


@pytest.mark.asyncio
async def test_terminate_worker_already_gone():
    """terminate_worker() handles ProcessLookupError gracefully."""
    shell = Shell.model_construct(worker_pid=99999)
    with patch("os.kill", side_effect=ProcessLookupError):
        await shell.terminate_worker()  # must not raise


@pytest.mark.asyncio
async def test_terminate_worker_sigterm_sufficient():
    """terminate_worker() sends SIGTERM; if process exits quickly, no SIGKILL sent."""
    import signal

    shell = Shell.model_construct(worker_pid=12345)
    kill_calls = []

    def fake_kill(pid, sig):
        kill_calls.append((pid, sig))

    # Process is gone immediately after SIGTERM
    with patch("os.kill", side_effect=fake_kill), \
         patch("psutil.pid_exists", return_value=False):
        await shell.terminate_worker()

    assert (12345, signal.SIGTERM) in kill_calls
    assert not any(sig == signal.SIGKILL for _, sig in kill_calls)


@pytest.mark.asyncio
async def test_terminate_worker_sigkill_fallback():
    """terminate_worker() falls back to SIGKILL when process survives deadline."""
    import signal

    shell = Shell.model_construct(worker_pid=12345)
    kill_calls = []

    def fake_kill(pid, sig):
        kill_calls.append((pid, sig))

    # Make the deadline expire immediately by returning a time past the deadline
    time_calls = [0]

    def fake_time():
        time_calls[0] += 1
        return 0.0 if time_calls[0] == 1 else 100.0  # deadline=3.0, loop sees 100.0 > deadline

    with patch("os.kill", side_effect=fake_kill), \
         patch("psutil.pid_exists", return_value=True), \
         patch("asyncio.get_event_loop") as mock_loop, \
         patch("asyncio.sleep", new_callable=AsyncMock):
        mock_loop.return_value.time = fake_time
        await shell.terminate_worker()

    assert (12345, signal.SIGTERM) in kill_calls
    assert (12345, signal.SIGKILL) in kill_calls


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
    """http_restart() calls exit() + start(); shell entity survives so same shell_id reused."""
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
         patch.object(AgenticProcess, "start", new_callable=AsyncMock, return_value=start_result):
        result = await process.http_restart()

    assert isinstance(result, ApiSuccessResponse)
    # shell entity survived exit — same shell_id going into start()
    assert process.shell_id == "shell-3"
