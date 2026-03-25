"""Tests for shell session elevation action.

Verifies the elevate-shell-session action handler builds correct
Claude CLI commands, transitions records to ELEVATED, and handles
error cases.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    """Set records root to tmp_path for all tests."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def _create_running_record(session_id: str = "test-session") -> ShellRecord:
    record = ShellRecord(
        id=session_id,
        pty_pid=session_id,
        workdir="/tmp",
        state=ShellStatus.RUNNING,
    )
    record.save()
    return record


def _make_mock_compute_node(session_id: str = "test-session"):
    """Create a mock ComputeNode with necessary attributes."""
    from flow_sdk.builtin.faas.pty_session_manager import PtySessionState

    cn = MagicMock()
    cn.id = "cn-1"
    cn.node_provider_id = "provider-1"
    cn.compute_provider = MagicMock()
    cn.compute_provider.send_pty_input = AsyncMock()

    # Session state
    session_state = PtySessionState(
        pty_key=("cn-1", "provider-1", session_id),
        cols=120,
        rows=40,
    )
    return cn, session_state


@pytest.mark.asyncio
async def test_elevate_shell_session_action_success():
    """Verify record transitions to elevated, claude_session_id set, response fields correct."""
    _create_running_record("elevate-test-1")
    cn, session_state = _make_mock_compute_node("elevate-test-1")

    mock_request_info = MagicMock()
    mock_request_info.get_post_data = AsyncMock(
        return_value={
            "shell_id": "elevate-test-1",
        }
    )

    with patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_request_info):
        with patch("flow_sdk.builtin.faas.compute_node.session_manager") as mock_sm:
            mock_sm.get_session = AsyncMock(return_value=session_state)

            from flow_sdk.builtin.faas.compute_node import ComputeNode

            handler = ComputeNode._elevate_shell_session
            response = await handler(cn)

    assert response.status == "SUCCESS"
    assert response.data["status"] == "elevated"
    assert response.data["shell_id"] == "elevate-test-1"
    assert "claude_session_id" in response.data

    # Verify record transitioned
    reloaded = ShellRecord.discover_one("elevate-test-1")
    assert reloaded.status == ShellStatus.ELEVATED
    assert reloaded.data.get("claude_session_id") == response.data["claude_session_id"]

    # Verify send_pty_input was called
    cn.compute_provider.send_pty_input.assert_called_once()
    call_args = cn.compute_provider.send_pty_input.call_args
    assert call_args[0][0] == "provider-1"  # provider_node_id
    assert call_args[0][1] == "elevate-test-1"  # session_id
    sent_cmd = call_args[0][2].decode()
    assert "claude" in sent_cmd
    assert "--session-id" in sent_cmd
    assert sent_cmd.endswith("\n")


@pytest.mark.asyncio
async def test_elevate_shell_session_not_found():
    """Unknown session_id returns ApiFailResponse."""
    cn, _ = _make_mock_compute_node()

    mock_request_info = MagicMock()
    mock_request_info.get_post_data = AsyncMock(
        return_value={
            "shell_id": "nonexistent",
        }
    )

    with patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_request_info):
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        response = await ComputeNode._elevate_shell_session(cn)

    assert response.status == "FAIL"
    assert "not found" in response.message.lower()


@pytest.mark.asyncio
async def test_elevate_shell_session_wrong_status():
    """Record with status=closed returns ApiFailResponse."""
    record = ShellRecord(
        id="closed-session",
        pty_pid="closed-session",
        state=ShellStatus.CLOSED,
    )
    record.save()

    cn, _ = _make_mock_compute_node("closed-session")

    mock_request_info = MagicMock()
    mock_request_info.get_post_data = AsyncMock(
        return_value={
            "shell_id": "closed-session",
        }
    )

    with patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_request_info):
        from flow_sdk.builtin.faas.compute_node import ComputeNode

        response = await ComputeNode._elevate_shell_session(cn)

    assert response.status == "FAIL"
    assert "not running" in response.message.lower()


@pytest.mark.asyncio
async def test_elevate_builds_correct_command():
    """Verify the command string includes model and permission flags."""
    _create_running_record("cmd-test")
    cn, session_state = _make_mock_compute_node("cmd-test")

    mock_request_info = MagicMock()
    mock_request_info.get_post_data = AsyncMock(
        return_value={
            "shell_id": "cmd-test",
            "model": "claude-sonnet-4-6",
            "permission_mode": "bypassPermissions",
        }
    )

    with patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_request_info):
        with patch("flow_sdk.builtin.faas.compute_node.session_manager") as mock_sm:
            mock_sm.get_session = AsyncMock(return_value=session_state)
            from flow_sdk.builtin.faas.compute_node import ComputeNode

            response = await ComputeNode._elevate_shell_session(cn)

    assert response.status == "SUCCESS"

    sent_cmd = cn.compute_provider.send_pty_input.call_args[0][2].decode()
    assert "--model claude-sonnet-4-6" in sent_cmd
    assert "--dangerously-skip-permissions" in sent_cmd


@pytest.mark.asyncio
async def test_elevate_with_resume():
    """resume_session_id produces --resume <id> in command."""
    _create_running_record("resume-test")
    cn, session_state = _make_mock_compute_node("resume-test")

    mock_request_info = MagicMock()
    mock_request_info.get_post_data = AsyncMock(
        return_value={
            "shell_id": "resume-test",
            "resume_session_id": "prev-claude-session-123",
        }
    )

    with patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_request_info):
        with patch("flow_sdk.builtin.faas.compute_node.session_manager") as mock_sm:
            mock_sm.get_session = AsyncMock(return_value=session_state)
            from flow_sdk.builtin.faas.compute_node import ComputeNode

            response = await ComputeNode._elevate_shell_session(cn)

    assert response.status == "SUCCESS"

    sent_cmd = cn.compute_provider.send_pty_input.call_args[0][2].decode()
    assert "--resume prev-claude-session-123" in sent_cmd
