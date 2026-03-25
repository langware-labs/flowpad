"""
API tests for AgenticProcess PTY message injection.

Tests that execute-plan and update-plan inject messages into the active PTY
session via _control_inject_message → _send_command_to_pty.
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_processor import AgenticProcess
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


@pytest.mark.asyncio
async def test_execute_plan_injects_to_pty(bootstrapped_client, user):
    """execute-plan with active PTY sends the plan prompt to _send_command_to_pty."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-pty-inject-execute",
        worker_session_id=str(uuid.uuid4()),
        shell_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    try:
        with patch.object(
            AgenticProcess, "_send_command_to_pty", new_callable=AsyncMock
        ) as mock_send, patch.object(
            AgenticProcess, "_resolve_compute_node", new_callable=AsyncMock
        ) as mock_resolve:
            mock_resolve.return_value = AsyncMock()

            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
                json={"file_path": "/some/plan.md", "clear_context": False},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value
            assert res.data.get("injected") is True

            # Should have called _send_command_to_pty once with the plan prompt
            assert mock_send.call_count == 1
            injected_msg = mock_send.call_args[0][1]
            assert "/some/plan.md" in injected_msg
            assert "plan-note" in injected_msg
    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_execute_plan_clear_context_injects_clear_then_plan(bootstrapped_client, user):
    """execute-plan with clear_context=True sends '/clear' then 'Execute plan'."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-pty-inject-clear",
        worker_session_id=str(uuid.uuid4()),
        shell_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    try:
        with patch.object(
            AgenticProcess, "_send_command_to_pty", new_callable=AsyncMock
        ) as mock_send, patch.object(
            AgenticProcess, "_resolve_compute_node", new_callable=AsyncMock
        ) as mock_resolve:
            mock_resolve.return_value = AsyncMock()

            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
                json={"file_path": "/some/plan.md", "clear_context": True},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value

            # Two calls: first /clear, then the plan prompt
            assert mock_send.call_count == 2
            first_call_msg = mock_send.call_args_list[0][0][1]
            second_call_msg = mock_send.call_args_list[1][0][1]
            assert first_call_msg == "/clear"
            assert "/some/plan.md" in second_call_msg
            assert "plan-note" in second_call_msg
    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_update_plan_injects_to_pty(bootstrapped_client, user):
    """update-plan with active PTY sends update prompt to _send_command_to_pty."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-pty-inject-update",
        worker_session_id=str(uuid.uuid4()),
        shell_id=str(uuid.uuid4()),
    )
    await process.save(user.typeid)

    try:
        with patch.object(
            AgenticProcess, "_send_command_to_pty", new_callable=AsyncMock
        ) as mock_send, patch.object(
            AgenticProcess, "_resolve_compute_node", new_callable=AsyncMock
        ) as mock_resolve:
            mock_resolve.return_value = AsyncMock()

            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/update-plan",
                json={"file_path": "/some/plan.md"},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value
            assert res.data.get("ok") is True

            assert mock_send.call_count == 1
            injected_msg = mock_send.call_args[0][1]
            assert "plan-note" in injected_msg
    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_inject_no_pty_skips_silently(bootstrapped_client, user):
    """When no PTY is active, _control_inject_message skips without error."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-no-pty-inject",
        worker_session_id=str(uuid.uuid4()),
        # No shell_id set
    )
    await process.save(user.typeid)

    try:
        with patch.object(
            AgenticProcess, "_send_command_to_pty", new_callable=AsyncMock
        ) as mock_send:
            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
                json={"file_path": "/some/plan.md", "clear_context": False},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value
            assert res.data.get("injected") is True

            # Should NOT have called _send_command_to_pty
            mock_send.assert_not_called()
    finally:
        await process.delete()


# ---------------------------------------------------------------------------
# Unit-level: verify _send_command_to_pty sends \r (Enter), not \n
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_command_to_pty_sends_carriage_return():
    """_send_command_to_pty must send \\r (Enter key) after the command, not \\n."""
    process = AgenticProcess(
        shell_id="shell-1",
    )

    mock_session_state = MagicMock(cols=120, rows=40)
    mock_session_manager = MagicMock()
    mock_session_manager.get_session = AsyncMock(return_value=mock_session_state)

    mock_provider = AsyncMock()
    mock_compute_node = MagicMock()
    mock_compute_node.id = "node-1"
    mock_compute_node.node_provider_id = "provider-1"
    mock_compute_node.compute_provider = mock_provider

    with patch(
        "flow_sdk.builtin.faas.pty_session_manager.session_manager", mock_session_manager
    ):
        await process._send_command_to_pty(mock_compute_node, "hello world")

    mock_provider.send_pty_input.assert_called_once()
    call_args = mock_provider.send_pty_input.call_args
    data_sent = call_args[0][2] if len(call_args[0]) > 2 else call_args.kwargs.get("data")

    assert data_sent == b"hello world\r", (
        f"Expected command followed by \\r (carriage return), got {data_sent!r}"
    )
    assert b"\n" not in data_sent, "Must not contain \\n — PTY Enter key is \\r"


@pytest.mark.asyncio
async def test_control_inject_message_sends_enter():
    """_control_inject_message sends Escape then command with \\r via _send_command_to_pty."""
    process = AgenticProcess(
        shell_id="shell-1",
    )

    mock_session_state = MagicMock(cols=80, rows=24)
    mock_session_manager = MagicMock()
    mock_session_manager.get_session = AsyncMock(return_value=mock_session_state)

    mock_provider = AsyncMock()
    mock_compute_node = MagicMock()
    mock_compute_node.id = "node-1"
    mock_compute_node.node_provider_id = "provider-1"
    mock_compute_node.compute_provider = mock_provider

    with patch(
        "flow_sdk.builtin.faas.pty_session_manager.session_manager", mock_session_manager
    ), patch.object(
        AgenticProcess, "_resolve_compute_node", new_callable=AsyncMock, return_value=mock_compute_node
    ):
        await process._control_inject_message("Execute plan")

    # 2 calls: Escape + command
    assert mock_provider.send_pty_input.call_count == 2
    # The command call (second) should end with \r
    cmd_call = mock_provider.send_pty_input.call_args_list[1]
    data_sent = cmd_call[0][2]

    assert data_sent == b"Execute plan\r", (
        f"Expected 'Execute plan\\r', got {data_sent!r}"
    )


# ---------------------------------------------------------------------------
# Unit-level: verify _control_inject_message sends Escape before the command
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_control_inject_message_sends_escape_before_command():
    """_control_inject_message sends Escape (\\x1b) first to dismiss any numeric prompt."""
    process = AgenticProcess(
        shell_id="shell-1",
    )

    mock_session_state = MagicMock(cols=80, rows=24)
    mock_session_manager = MagicMock()
    mock_session_manager.get_session = AsyncMock(return_value=mock_session_state)

    mock_provider = AsyncMock()
    mock_compute_node = MagicMock()
    mock_compute_node.id = "node-1"
    mock_compute_node.node_provider_id = "provider-1"
    mock_compute_node.compute_provider = mock_provider

    with patch(
        "flow_sdk.builtin.faas.pty_session_manager.session_manager", mock_session_manager
    ), patch.object(
        AgenticProcess, "_resolve_compute_node", new_callable=AsyncMock, return_value=mock_compute_node
    ):
        await process._control_inject_message("Execute plan")

    # Should have 2 calls: first Escape, then the command
    assert mock_provider.send_pty_input.call_count == 2, (
        f"Expected 2 send_pty_input calls (Escape + command), got {mock_provider.send_pty_input.call_count}"
    )

    # First call: single Escape byte (must be sent alone so the terminal
    # input parser doesn't merge it with the following command bytes)
    esc_call = mock_provider.send_pty_input.call_args_list[0]
    esc_data = esc_call[0][2]
    assert esc_data == b"\x1b", f"First call should send Escape (\\x1b), got {esc_data!r}"

    # Second call: the actual command with \r
    cmd_call = mock_provider.send_pty_input.call_args_list[1]
    cmd_data = cmd_call[0][2]
    assert cmd_data == b"Execute plan\r", f"Second call should send command, got {cmd_data!r}"
