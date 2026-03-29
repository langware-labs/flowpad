"""
API tests for AgenticProcess PTY message injection.

Tests that execute-plan and update-plan inject messages into the active PTY
session via _control_inject_message → _send_command_to_pty.
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


@pytest.mark.asyncio
async def test_execute_plan_injects_to_pty(bootstrapped_client, user):
    """execute-plan with active PTY sends the plan prompt to _send_command_to_pty."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-pty-inject-execute",
        worker_session_id=str(uuid.uuid4()),
        shell_id=str(uuid.uuid4()),
        compute_node_id=f"compute_node-{uuid.uuid4()}",
    )
    await process.save(user.typeid)

    try:
        with patch.object(
            AgenticProcess, "_send_command_to_pty", new_callable=AsyncMock
        ) as mock_send, patch.object(
            AgenticProcess, "_send_pty_raw", new_callable=AsyncMock
        ):
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
        compute_node_id=f"compute_node-{uuid.uuid4()}",
    )
    await process.save(user.typeid)

    try:
        with patch.object(
            AgenticProcess, "_send_command_to_pty", new_callable=AsyncMock
        ) as mock_send, patch.object(
            AgenticProcess, "_send_pty_raw", new_callable=AsyncMock
        ):
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
        compute_node_id=f"compute_node-{uuid.uuid4()}",
    )
    await process.save(user.typeid)

    try:
        with patch.object(
            AgenticProcess, "_send_command_to_pty", new_callable=AsyncMock
        ) as mock_send, patch.object(
            AgenticProcess, "_send_pty_raw", new_callable=AsyncMock
        ):
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
