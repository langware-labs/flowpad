"""Unit tests for AgenticProcess and Shell lifecycle semantics.

Tests:
- process.exit()    — keeps shell entity alive (status=idle)
- process.close()   — deletes shell entity, keeps shell_id reserved
- process.restart() — shell_id preserved across exit + start
- shell.terminate_worker() — SIGTERM then SIGKILL on worker_pid
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.shell import Shell


# NOTE: ``test_driver_preassign_interactive_session_id_flags`` was removed
# when CodexDriver migrated to the TranscriptDescriptor-based session
# discovery (see ``flow_sdk/builtin/agentic_process/cli_drivers/codex/
# driver.py``). The ``preassign_interactive_session_id`` attribute no longer
# exists — Codex now finds the rollout via ``find_latest_codex_session_jsonl``
# (cwd + launch-time lookback) instead of pre-assigning the session id.


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
    mock_shell.stop = AsyncMock()
    mock_shell.close = AsyncMock()

    with patch("flow_sdk.builtin.shell.Shell.get_by_id", return_value=mock_shell), \
         patch.object(AgenticProcess, "save", new_callable=AsyncMock):
        from flow_sdk.responses.response import ApiSuccessResponse
        result = await process.exit()

    assert isinstance(result, ApiSuccessResponse)
    mock_shell.stop.assert_awaited_once()  # stop() now handles worker termination internally
    mock_shell.close.assert_not_awaited()
    # shell_id still set — shell entity is alive
    assert process.shell_id == "shell-1"


# ---------------------------------------------------------------------------
# AgenticProcess._http_close() — deletes shell
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_close_deletes_shell():
    """process._http_close() deletes the shell entity but keeps the shell_id reserved."""
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
    # shell_id stays reserved for the next open; close deletes the Shell row.
    assert process.shell_id == "shell-2"
    assert process.sidecar_shell_id is None


@pytest.mark.asyncio
async def test_start_pty_reloads_process_inside_open_lock_and_applies_session_override():
    """start_pty() must run open recovery on the locked, freshly loaded process."""
    stale = AgenticProcess.model_construct(
        id="proc-open-lock",
        shell_id="stale-shell",
        session_id=None,
        context_data={},
    )
    fresh = AgenticProcess.model_construct(
        id="proc-open-lock",
        shell_id="fresh-shell",
        session_id=None,
        context_data={},
    )

    from flow_sdk.responses.response import ApiSuccessResponse
    expected = ApiSuccessResponse(data={"shell_id": "fresh-shell"})
    calls = []

    async def fake_perform_open(self, instruction, visible, retry=False):
        calls.append((self, instruction, visible, retry, self.session_id))
        return expected

    with patch.object(AgenticProcess, "get_by_id", new_callable=AsyncMock, return_value=fresh), \
         patch.object(AgenticProcess, "_perform_open", new=fake_perform_open):
        result = await stale.start_pty(
            instruction="resume",
            visible=True,
            retry=True,
            session_id_override="session-override",
        )

    assert result is expected
    assert calls == [(fresh, "resume", True, True, "session-override")]
    assert stale.session_id is None


@pytest.mark.asyncio
async def test_start_pty_saves_unsaved_process_before_locked_reload():
    """Direct SDK-created processes still persist before start_pty() opens them."""
    unsaved = AgenticProcess.model_construct(
        id="proc-unsaved-open",
        shell_id=None,
        session_id=None,
        context_data={},
        created_by=None,
    )
    fresh = AgenticProcess.model_construct(
        id="proc-unsaved-open",
        shell_id=None,
        session_id=None,
        context_data={},
        created_by="test",
    )

    from flow_sdk.responses.response import ApiSuccessResponse
    expected = ApiSuccessResponse(data={"id": "proc-unsaved-open"})

    async def fake_perform_open(self, instruction, visible, retry=False):
        return expected

    with patch.object(AgenticProcess, "get_by_id", new_callable=AsyncMock, side_effect=[None, fresh]) as get_by_id, \
         patch.object(AgenticProcess, "save", new_callable=AsyncMock) as save, \
         patch.object(AgenticProcess, "_perform_open", new=fake_perform_open):
        result = await unsaved.start_pty()

    assert result is expected
    assert get_by_id.await_args_list[0].args == ("proc-unsaved-open",)
    assert get_by_id.await_args_list[1].args == ("proc-unsaved-open",)
    save.assert_awaited_once()


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


# ---------------------------------------------------------------------------
# Failed-to-start latch (`start_failure`) — instant-exit classification and
# the open() gate. The latch is what breaks the spawn → instant-death →
# auto-reopen loop; the long-lived-exit case asserts crash-healing survives.
# ---------------------------------------------------------------------------


def _latchable_process(**overrides):
    base = dict(
        id="proc-latch",
        shell_id="shell-latch",
        sidecar_shell_id=None,
        session_id=None,  # skip the _index_session_on_close task
        context_data={},
        status="running",
        start_failure=None,
    )
    base.update(overrides)
    return AgenticProcess.model_construct(**base)


async def _fire_exit_callback(process, *, lifetime: float, exit_code=None):
    """Create the exit callback with a controlled spawn clock, fire it, and
    let the scheduled state update run to completion."""
    from flow_sdk.builtin.agentic_process import agentic_process as ap_module

    # ``ap_module.time`` IS the stdlib time module, which asyncio also uses —
    # so patch each call site in its own narrow scope with a constant
    # ``return_value`` (a shared side_effect list gets drained by the loop).
    with patch.object(ap_module.time, "monotonic", return_value=100.0):
        on_exit = process._make_pty_exit_callback()  # captures spawned_at=100.0
    with patch.object(AgenticProcess, "get_by_id", new_callable=AsyncMock, return_value=process), \
         patch.object(AgenticProcess, "save", new_callable=AsyncMock) as mock_save:
        with patch.object(ap_module.time, "monotonic", return_value=100.0 + lifetime):
            on_exit(exit_code)  # reads monotonic() once → lifetime
        # run_coroutine_threadsafe scheduled _update_state on this loop —
        # yield until it has run (save awaited) instead of sleeping.
        import asyncio
        for _ in range(20):
            await asyncio.sleep(0)
            if mock_save.await_count:
                break
    return mock_save


@pytest.mark.asyncio
async def test_instant_exit_latches_failed_to_start():
    """A worker that dies within the instant-exit window lands in FAILED with
    `start_failure` set — the latch that stops the auto-recovery sweep."""
    process = _latchable_process()
    mock_save = await _fire_exit_callback(process, lifetime=0.9, exit_code=None)

    assert mock_save.await_count, "_update_state never ran"
    assert process.status == "failed"
    assert process.start_failure is not None
    assert "0.9s after launch" in process.start_failure


@pytest.mark.asyncio
async def test_long_lived_exit_stays_recoverable():
    """A worker that outlives the window and then dies is a normal STOPPED —
    no latch — so crash-healing (auto-reopen after backend restart) still works."""
    process = _latchable_process()
    mock_save = await _fire_exit_callback(process, lifetime=120.0, exit_code=None)

    assert mock_save.await_count, "_update_state never ran"
    assert process.status == "stopped"
    assert process.start_failure is None


@pytest.mark.asyncio
async def test_open_gate_refuses_latched_process():
    """open() on a latched process is refused without spawning anything —
    this is what stops the 5s auto-recovery sweep from relaunching it."""
    from flow_sdk.responses.response import ApiFailResponse

    process = _latchable_process(status="failed", start_failure="Worker exited 0.9s after launch (exit code 1).")

    with patch.object(AgenticProcess, "reap_if_orphaned", new_callable=AsyncMock, return_value=False), \
         patch.object(AgenticProcess, "get_project", new_callable=AsyncMock) as mock_get_project:
        result = await process._perform_open(None, None, retry=False)

    assert isinstance(result, ApiFailResponse)
    assert "failed to start" in result.message.lower()
    assert "retry" in result.message.lower()
    # Gate returned before any launch work — project resolution never ran.
    mock_get_project.assert_not_awaited()
    # Latch is NOT cleared by a refused open.
    assert process.start_failure is not None


@pytest.mark.asyncio
async def test_open_gate_retry_clears_latch():
    """open(retry=True) — the explicit user retry — clears the latch and
    proceeds into the launch path."""
    process = _latchable_process(status="failed", shell_id=None, start_failure="Worker exited 0.9s after launch (exit code 1).")

    # Let the launch path proceed past the gate, then stop it deterministically
    # at cli-options finalization — we only assert gate semantics here.
    with patch.object(AgenticProcess, "reap_if_orphaned", new_callable=AsyncMock, return_value=False), \
         patch.object(AgenticProcess, "get_project", new_callable=AsyncMock), \
         patch.object(AgenticProcess, "save", new_callable=AsyncMock), \
         patch.object(AgenticProcess, "_finalized_restart_cli_options", side_effect=RuntimeError("STOP_TEST")):
        result = await process._perform_open(None, None, retry=True)

    # The latch was cleared by the retry before the (test-injected) failure.
    assert process.start_failure is None
    from flow_sdk.responses.response import ApiFailResponse
    assert isinstance(result, ApiFailResponse)
    assert result.message == "STOP_TEST"


@pytest.mark.asyncio
async def test_open_missing_fork_source_fails_before_shell_spawn():
    """A vanished fork parent must not degrade into ``--resume <new-id>``."""
    from flow_sdk.builtin.agentic_process.cli_drivers.claude import ClaudeCliOptions
    from flow_sdk.responses.response import ApiFailResponse

    source_id = "missing-fork-source"
    process = AgenticProcess.fork(source_id, workdir="/project", visible=True)
    cmd = ClaudeCliOptions(
        workdir="/project",
        session_id=process.session_id,
        resume=True,
        fork_session_id=source_id,
    )

    with patch.object(AgenticProcess, "reap_if_orphaned", new_callable=AsyncMock, return_value=False), \
         patch.object(AgenticProcess, "get_project", new_callable=AsyncMock), \
         patch.object(AgenticProcess, "prepare_system_instruction_assets", new_callable=AsyncMock, return_value=[]), \
         patch.object(AgenticProcess, "_apply_system_instruction_assets"), \
         patch.object(AgenticProcess, "_finalized_restart_cli_options", return_value=cmd), \
         patch.object(AgenticProcess, "_find_resumable_session", new_callable=AsyncMock, return_value=None), \
         patch.object(AgenticProcess, "_get_or_create_shell", new_callable=AsyncMock) as create_shell:
        result = await process._perform_open(None, True)

    assert isinstance(result, ApiFailResponse)
    assert result.status_code == 404
    assert source_id in (result.message or "")
    create_shell.assert_not_awaited()
