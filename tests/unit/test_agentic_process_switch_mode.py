"""Unit tests for the standardized ``switch-mode`` action — the single backend
seam the frontend ``AgenticProcess.switchMode(mode)`` (ribbon chat⇄terminal
toggle) calls. Mirrors the vitest ``agentic-process-switch-mode.test.ts``.

Transport switch over ONE logical session; routing stays ``headless == !visible``:
  - ``cli``         → headless (kill PTY, visible=False, pty_mode=False)
  - ``interactive`` → PTY (the canonical ``_perform_open`` path, visible=True)

Request-body is supplied via the same ``get_current_request_info`` mock the
existing fork-action tests use — the HTTP transport boundary, not the logic.
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def _proc(**kwargs) -> AgenticProcess:
    return AgenticProcess(id=str(uuid.uuid4()), **kwargs)


def _req(mode: str) -> MagicMock:
    req = MagicMock()
    req.get_post_data = AsyncMock(return_value={"mode": mode})
    return req


@pytest.mark.asyncio
async def test_switch_mode_cli_flips_to_headless():
    """mode=cli kills the PTY intent and persists visible=False + pty_mode=False."""
    proc = _proc(visible=True, pty_mode=True)  # no shell_id → nothing to kill

    with patch(
        "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
        return_value=_req("cli"),
    ):
        resp = await proc.switch_mode()

    assert isinstance(resp, ApiSuccessResponse)
    assert resp.data["visible"] is False
    assert resp.data["pty_mode"] is False


@pytest.mark.asyncio
async def test_switch_mode_interactive_routes_to_open():
    """mode=interactive dispatches to the canonical PTY open path with visible=True."""
    proc = _proc(visible=False, pty_mode=False)
    sentinel = ApiSuccessResponse(data={"opened": True})

    with patch.object(AgenticProcess, "start_pty", new_callable=AsyncMock) as mock_open, patch(
        "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
        return_value=_req("interactive"),
    ):
        mock_open.return_value = sentinel
        resp = await proc.switch_mode()

    mock_open.assert_called_once_with(instruction=None, visible=True, retry=True)
    assert resp is sentinel


@pytest.mark.asyncio
async def test_failed_open_restores_headless_transport_and_latches_failure():
    """A failed PTY launch leaves the prior chat transport coherent and retryable."""
    shell_id = str(uuid.uuid4())
    proc = _proc(
        visible=False,
        pty_mode=False,
        status="stopped",
        shell_id=shell_id,
        session_id=str(uuid.uuid4()),
    )

    with patch.object(
        AgenticProcess, "reap_if_orphaned", new_callable=AsyncMock, return_value=False
    ), patch.object(
        AgenticProcess, "shell", new_callable=AsyncMock, return_value=None
    ), patch.object(
        AgenticProcess, "get_project", new_callable=AsyncMock
    ), patch.object(
        AgenticProcess,
        "prepare_system_instruction_assets",
        new_callable=AsyncMock,
        return_value=[],
    ), patch.object(
        AgenticProcess,
        "_finalized_restart_cli_options",
        side_effect=RuntimeError("C15 spawn failed"),
    ), patch.object(AgenticProcess, "save", new_callable=AsyncMock):
        result = await proc._perform_open(None, True, retry=True)

    assert isinstance(result, ApiFailResponse)
    assert result.message == "C15 spawn failed"
    assert proc.status == "failed"
    assert proc.start_failure == "C15 spawn failed"
    assert proc.visible is False
    assert proc.pty_mode is False
    assert proc.shell_id == shell_id


@pytest.mark.asyncio
async def test_switch_mode_unknown_rejected():
    """An unrecognized mode is a clean ApiFailResponse, not a silent no-op."""
    proc = _proc(visible=True, pty_mode=True)

    with patch(
        "flow_sdk.builtin.agentic_process.agentic_process.get_current_request_info",
        return_value=_req("bogus"),
    ):
        resp = await proc.switch_mode()

    assert isinstance(resp, ApiFailResponse)
    assert "unknown mode" in resp.message
