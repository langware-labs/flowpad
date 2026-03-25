"""Test that PTY exit with code 0 resets AgenticProcess state.status to 'idle'."""
import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.fs_records.agentic_process_record import ProcessorStatus


class TestPtyExitStatusReset:
    """When a PTY exits cleanly (code 0), status must revert to idle."""

    @pytest.mark.asyncio
    async def test_pty_clean_exit_resets_status_to_idle(self):
        """_on_pty_exit with exit_code=0 must update status to IDLE."""
        from flow_sdk.builtin.agentic_processor import AgenticProcess
        from flow_sdk.builtin.shell import Shell

        # Build a minimal entity via normal constructor
        proc = AgenticProcess(
            id="test-proc-id",
            worker_session_id="ws-123",
            shell_id="some-shell-id",
        )
        # Manually set state to 'running' (as start does)
        proc._set_process_state(status=ProcessorStatus.RUNNING.value, error=None)

        with (
            patch.object(AgenticProcess, "get_by_id", new=AsyncMock(return_value=proc)),
            patch.object(AgenticProcess, "save", new=AsyncMock()),
            patch.object(Shell, "get_by_id", new=AsyncMock(return_value=None)),
        ):
            # _make_pty_exit_callback calls asyncio.get_running_loop() — must be in async ctx
            callback = proc._make_pty_exit_callback()
            # Simulate clean PTY exit (code 0 — Claude finished normally)
            callback(0)
            # Give the threadsafe coroutine time to execute on this loop
            await asyncio.sleep(0.1)

        # After clean exit, status MUST be 'idle' (not 'running')
        final_status = proc.state.get("status")
        assert final_status == ProcessorStatus.IDLE.value, (
            f"Expected status='idle' after clean PTY exit, got status='{final_status}'."
        )
