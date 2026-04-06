"""
API tests for AgenticProcess PTY message injection.

Tests that execute-plan and update-plan inject messages into the active PTY
session via inject → send.
"""

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.responses.response import ApiResponse, ApiResponseStatus


def _str_calls(mock):
    """Return only the send calls that carried a plain string (not bytes)."""
    return [c for c in mock.call_args_list if isinstance(c[0][0], str)]


@pytest.mark.asyncio
async def test_execute_plan_injects_to_pty(bootstrapped_client, user):
    """execute-plan with active PTY sends the plan prompt via send."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-pty-inject-execute",
        session_id=str(uuid.uuid4()),
        shell_id=str(uuid.uuid4()),
        compute_node_id=f"compute_node-{uuid.uuid4()}",
    )
    await process.save(user.typeid)

    try:
        with patch.object(AgenticProcess, "send", new_callable=AsyncMock) as mock_send:
            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
                json={"file_path": "/some/plan.md", "clear_context": False},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value
            assert res.data.get("injected") is True

            string_calls = _str_calls(mock_send)
            assert len(string_calls) == 1
            injected_msg = string_calls[0][0][0]
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
        session_id=str(uuid.uuid4()),
        shell_id=str(uuid.uuid4()),
        compute_node_id=f"compute_node-{uuid.uuid4()}",
    )
    await process.save(user.typeid)

    try:
        with patch.object(AgenticProcess, "send", new_callable=AsyncMock) as mock_send:
            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
                json={"file_path": "/some/plan.md", "clear_context": True},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value

            # Two string calls: first /clear, then the plan prompt
            string_calls = _str_calls(mock_send)
            assert len(string_calls) == 2
            assert string_calls[0][0][0] == "/clear"
            assert "/some/plan.md" in string_calls[1][0][0]
            assert "plan-note" in string_calls[1][0][0]
    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_update_plan_injects_to_pty(bootstrapped_client, user):
    """update-plan with active PTY sends update prompt via send."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-pty-inject-update",
        session_id=str(uuid.uuid4()),
        shell_id=str(uuid.uuid4()),
        compute_node_id=f"compute_node-{uuid.uuid4()}",
    )
    await process.save(user.typeid)

    try:
        with patch.object(AgenticProcess, "send", new_callable=AsyncMock) as mock_send:
            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/update-plan",
                json={"file_path": "/some/plan.md"},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value
            assert res.data.get("ok") is True

            string_calls = _str_calls(mock_send)
            assert len(string_calls) == 1
            assert "plan-note" in string_calls[0][0][0]
    finally:
        await process.delete()


@pytest.mark.asyncio
async def test_inject_no_pty_skips_silently(bootstrapped_client, user):
    """When no PTY is active, inject skips without error."""
    client = bootstrapped_client

    process = AgenticProcess(
        name="test-no-pty-inject",
        session_id=str(uuid.uuid4()),
        # No shell_id set
    )
    await process.save(user.typeid)

    try:
        with patch.object(AgenticProcess, "send", new_callable=AsyncMock) as mock_send:
            resp = await client.post(
                f"/api/v1/graph/agentic_process/{process.id}/execute-plan",
                json={"file_path": "/some/plan.md", "clear_context": False},
            )
            assert resp.status_code == 200, resp.text
            res = ApiResponse(**resp.json())
            assert res.status == ApiResponseStatus.SUCCESS.value
            assert res.data.get("injected") is True

            # Should NOT have called send_input
            mock_send.assert_not_called()
    finally:
        await process.delete()
