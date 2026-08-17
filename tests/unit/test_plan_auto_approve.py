"""Unit tests for plan auto-approve hook feature.

Tests the flag lifecycle for auto-approving ExitPlanMode PermissionRequests:
- Flag is set by execute_plan() using entity ID
- Flag is consumed (cleared) only when PermissionRequest:ExitPlanMode is approved
- Flag survives all intermediate hook events
- Entity ID resolution via execution_scope in hook data
- --wait-for-response parameter makes hooks_report synchronous for PermissionRequest
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from typer.testing import CliRunner

from flow_sdk.app.actions.listen import (
    _plan_auto_approve_by_agentic_process,
    handle_agent_hook,
    set_plan_auto_approve,
)
from flow_sdk.cli.flow_cli import app
from flow_sdk.core.flow.models.webhook_flow_data import AgentHookData
from flow_sdk.responses.response import ApiSuccessResponse

ENTITY_ID = "d96c2d97-0e9b-468f-9a84-35e9762acf14"


class TestPlanAutoApproveHelpers:
    """Test the flag management helper functions."""

    def setup_method(self):
        _plan_auto_approve_by_agentic_process.clear()

    def test_set_plan_auto_approve(self):
        """Flag is set when set_plan_auto_approve is called with entity ID."""
        set_plan_auto_approve(ENTITY_ID)
        assert ENTITY_ID in _plan_auto_approve_by_agentic_process

    def test_set_plan_auto_approve_with_empty_id(self):
        """Setting flag with empty ID is a no-op."""
        set_plan_auto_approve("")
        assert "" not in _plan_auto_approve_by_agentic_process

    def test_set_plan_auto_approve_with_none(self):
        """Setting flag with None is a no-op."""
        set_plan_auto_approve(None)
        assert len(_plan_auto_approve_by_agentic_process) == 0


class TestPlanAutoApproveHookHandler:
    """Test the handle_agent_hook function with auto-approve logic."""

    def setup_method(self):
        _plan_auto_approve_by_agentic_process.clear()

    def _create_webhook_data(
        self,
        hook_event: str,
        tool_name: str = "",
        session_id: str = "test-session",
        tool_input: dict = None,
        entity_id: str = None,
    ) -> AgentHookData:
        """Helper to create AgentHookData for testing."""
        execution_scope = [{"type": "agentic_process", "id": entity_id}] if entity_id else None
        hook_data = {
            "hook_event_name": hook_event,
            "tool_name": tool_name,
            "session_id": session_id,
            "tool_input": tool_input or {},
            "execution_scope": execution_scope,
            "raw_hook_data": {},
        }
        return AgentHookData(
            agent_hook_id="hook-123",
            hook_data=hook_data,
            hook_entry_id="entry-123",
            hook_metadata={},
            hook_file_path="/path/to/hook",
        )

    @pytest.mark.asyncio
    async def test_permission_request_exit_plan_auto_approved(self):
        """PermissionRequest:ExitPlanMode is auto-approved when flag is set."""
        set_plan_auto_approve(ENTITY_ID)

        webhook_data = self._create_webhook_data(
            hook_event="PermissionRequest",
            tool_name="ExitPlanMode",
            session_id="new-session-after-clear",
            entity_id=ENTITY_ID,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock())
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            result = await handle_agent_hook(webhook_data)

        assert isinstance(result, ApiSuccessResponse)
        assert result.data["hookSpecificOutput"]["decision"]["behavior"] == "allow"
        assert result.data["hookSpecificOutput"]["hookEventName"] == "PermissionRequest"
        assert ENTITY_ID not in _plan_auto_approve_by_agentic_process

    @pytest.mark.asyncio
    async def test_permission_request_exit_plan_not_approved_without_flag(self):
        """PermissionRequest:ExitPlanMode is not auto-approved if flag is not set."""
        webhook_data = self._create_webhook_data(
            hook_event="PermissionRequest",
            tool_name="ExitPlanMode",
            session_id="test-session",
            entity_id=ENTITY_ID,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            result = await handle_agent_hook(webhook_data)

        assert isinstance(result, ApiSuccessResponse)
        assert "hookSpecificOutput" not in result.data or "decision" not in result.data.get("hookSpecificOutput", {})

    @pytest.mark.asyncio
    async def test_read_operation_does_not_clear_flag(self):
        """PostToolUse:Read does not clear the auto-approve flag."""
        set_plan_auto_approve(ENTITY_ID)

        webhook_data = self._create_webhook_data(
            hook_event="PostToolUse",
            tool_name="Read",
            entity_id=ENTITY_ID,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            await handle_agent_hook(webhook_data)

        assert ENTITY_ID in _plan_auto_approve_by_agentic_process

    @pytest.mark.asyncio
    async def test_write_operation_does_not_clear_flag(self):
        """PostToolUse:Write does not clear the auto-approve flag."""
        set_plan_auto_approve(ENTITY_ID)

        webhook_data = self._create_webhook_data(
            hook_event="PostToolUse",
            tool_name="Write",
            tool_input={"file_path": "/path/to/plan.md"},
            entity_id=ENTITY_ID,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            await handle_agent_hook(webhook_data)

        assert ENTITY_ID in _plan_auto_approve_by_agentic_process

    @pytest.mark.asyncio
    async def test_user_prompt_submit_clears_flag(self):
        """UserPromptSubmit clears the auto-approve flag (stale flag cleanup)."""
        set_plan_auto_approve(ENTITY_ID)

        webhook_data = self._create_webhook_data(
            hook_event="UserPromptSubmit",
            entity_id=ENTITY_ID,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            with patch("flow_sdk.app.actions.listen._create_prompt_annotation", new_callable=AsyncMock):
                await handle_agent_hook(webhook_data)

        assert ENTITY_ID not in _plan_auto_approve_by_agentic_process

    @pytest.mark.asyncio
    async def test_flag_survives_pre_tool_use(self):
        """PreToolUse events do NOT clear the flag."""
        set_plan_auto_approve(ENTITY_ID)

        webhook_data = self._create_webhook_data(
            hook_event="PreToolUse",
            tool_name="Bash",
            entity_id=ENTITY_ID,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            await handle_agent_hook(webhook_data)

        assert ENTITY_ID in _plan_auto_approve_by_agentic_process

    @pytest.mark.asyncio
    async def test_execute_plan_full_flow_with_session_change(self):
        """Full flow: inject fires UserPromptSubmit BEFORE flag is set, then ExitPlanMode is auto-approved.

        Real sequence (execute_plan sets flag AFTER inject returns):
        1. /clear injected → UserPromptSubmit (flag not set yet — no-op)
        2. prompt injected → UserPromptSubmit (flag not set yet — no-op)
        3. set_plan_auto_approve(entity_id) — flag set
        4. Claude processes → tool events → PermissionRequest:ExitPlanMode → auto-approved
        """
        new_session = "new-session-after-clear"

        # Step 1-2: UserPromptSubmit events from injected commands arrive BEFORE flag is set
        pre_flag_events = [
            ("UserPromptSubmit", ""),  # from /clear
            ("UserPromptSubmit", ""),  # from injected prompt
        ]

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            with patch("flow_sdk.app.actions.listen._create_prompt_annotation", new_callable=AsyncMock):
                for event, tool in pre_flag_events:
                    wd = self._create_webhook_data(
                        hook_event=event, tool_name=tool, session_id=new_session, entity_id=ENTITY_ID
                    )
                    await handle_agent_hook(wd)

        # Flag not set yet — UserPromptSubmit was a no-op
        assert ENTITY_ID not in _plan_auto_approve_by_agentic_process

        # Step 3: Flag set AFTER inject returns
        set_plan_auto_approve(ENTITY_ID)

        # Step 4: Tool events arrive while Claude works — flag survives
        tool_events = [
            ("PreToolUse", "Read"),
            ("PostToolUse", "Read"),
            ("PreToolUse", "Write"),
            ("PostToolUse", "Write"),
        ]

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            for event, tool in tool_events:
                wd = self._create_webhook_data(
                    hook_event=event, tool_name=tool, session_id=new_session, entity_id=ENTITY_ID
                )
                await handle_agent_hook(wd)

        assert ENTITY_ID in _plan_auto_approve_by_agentic_process

        # PermissionRequest:ExitPlanMode — auto-approved and flag consumed
        webhook_data = self._create_webhook_data(
            hook_event="PermissionRequest",
            tool_name="ExitPlanMode",
            session_id=new_session,
            entity_id=ENTITY_ID,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            result = await handle_agent_hook(webhook_data)

        assert isinstance(result, ApiSuccessResponse)
        assert result.data["hookSpecificOutput"]["decision"]["behavior"] == "allow"
        assert ENTITY_ID not in _plan_auto_approve_by_agentic_process

    @pytest.mark.asyncio
    async def test_multiple_entities_independent_flags(self):
        """Flags for different entities are independent."""
        entity_1 = "entity-1"
        entity_2 = "entity-2"

        set_plan_auto_approve(entity_1)
        set_plan_auto_approve(entity_2)

        # Consume entity_1 flag
        webhook_data_1 = self._create_webhook_data(
            hook_event="PermissionRequest",
            tool_name="ExitPlanMode",
            session_id="session-1",
            entity_id=entity_1,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock())
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            await handle_agent_hook(webhook_data_1)

        assert entity_1 not in _plan_auto_approve_by_agentic_process
        assert entity_2 in _plan_auto_approve_by_agentic_process

    @pytest.mark.asyncio
    async def test_no_execution_scope_means_no_auto_approve(self):
        """PermissionRequest:ExitPlanMode without execution_scope is not auto-approved."""
        set_plan_auto_approve(ENTITY_ID)

        # No entity_id → no execution_scope in hook data
        webhook_data = self._create_webhook_data(
            hook_event="PermissionRequest",
            tool_name="ExitPlanMode",
            session_id="test-session",
            entity_id=None,
        )

        with patch("flow_sdk.builtin.agent_hook.AgentHook") as mock_agent_hook_cls:
            mock_hook = AsyncMock()
            mock_hook.handle_webhook = AsyncMock(return_value=MagicMock(model_dump=MagicMock(return_value={})))
            mock_hook.emit_flow_data = AsyncMock()
            mock_agent_hook_cls.get_by_id = AsyncMock(return_value=mock_hook)

            result = await handle_agent_hook(webhook_data)

        # Not auto-approved
        assert isinstance(result, ApiSuccessResponse)
        assert "hookSpecificOutput" not in result.data or "decision" not in result.data.get("hookSpecificOutput", {})
        # Flag still set
        assert ENTITY_ID in _plan_auto_approve_by_agentic_process


def _extract_decision_json(output: str) -> dict:
    """Extract the JSON decision line from CLI output (ignoring stderr log lines)."""
    for line in output.strip().splitlines():
        line = line.strip()
        if line.startswith("{"):
            return json.loads(line)
    raise ValueError(f"No JSON found in output: {output!r}")


class TestHooksReportWaitForResponse:
    """Test the --wait-for-response parameter in hooks report command.

    Claude Code reads the hook's stdout JSON to determine permission decisions.
    Expected format: {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"|"deny"}}}
    Exit code is always 0; the JSON output determines allow/deny.
    """

    def setup_method(self):
        _plan_auto_approve_by_agentic_process.clear()

    def test_hooks_report_without_wait_for_response_exits_zero(self):
        runner = CliRunner()
        hook_data = {
            "hook_event_name": "PermissionRequest",
            "session_id": "test-session",
            "tool_name": "ExitPlanMode",
        }

        with patch("flow_sdk.cli.commands._common.local_post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                text='{"data": {"hookSpecificOutput": {"permissionDecision": "deny"}}}',
                json=MagicMock(return_value={"data": {"hookSpecificOutput": {"permissionDecision": "deny"}}}),
            )

            result = runner.invoke(
                app,
                ["hooks", "report", "--name", "test"],
                input=json.dumps(hook_data),
            )

        # Fire-and-forget mode: no stdout decision output
        assert result.exit_code == 0

    def test_hooks_report_wait_for_response_allow_outputs_allow(self):
        """Server returns data with hookSpecificOutput — CLI echoes it as-is to stdout."""
        runner = CliRunner()
        hook_data = {
            "hook_event_name": "PermissionRequest",
            "session_id": "test-session",
            "tool_name": "ExitPlanMode",
        }
        allow_data = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}

        with patch("flow_sdk.cli.commands._common.local_post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                text=json.dumps({"data": allow_data}),
                json=MagicMock(return_value={"data": allow_data}),
            )

            result = runner.invoke(
                app,
                ["hooks", "report", "--name", "test", "--wait-for-response"],
                input=json.dumps(hook_data),
            )

        assert result.exit_code == 0
        stdout_json = _extract_decision_json(result.output)
        assert stdout_json["hookSpecificOutput"]["decision"]["behavior"] == "allow"

    def test_hooks_report_wait_for_response_echoes_data(self):
        """Server returns data — CLI echoes it as-is to stdout."""
        runner = CliRunner()
        hook_data = {
            "hook_event_name": "PermissionRequest",
            "session_id": "test-session",
            "tool_name": "ExitPlanMode",
        }

        with patch("flow_sdk.cli.commands._common.local_post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                text='{"data": {"status": "received"}}',
                json=MagicMock(return_value={"data": {"status": "received"}}),
            )

            result = runner.invoke(
                app,
                ["hooks", "report", "--name", "test", "--wait-for-response"],
                input=json.dumps(hook_data),
            )

        assert result.exit_code == 0
        stdout_json = _extract_decision_json(result.output)
        assert stdout_json["status"] == "received"

    def test_hooks_report_wait_for_response_no_decision_no_output(self):
        """When server has no explicit decision, don't output any decision JSON.
        This lets Claude Code use its default behavior (show prompt to user)."""
        runner = CliRunner()
        hook_data = {
            "hook_event_name": "PermissionRequest",
            "session_id": "test-session",
            "tool_name": "AskUserQuestion",
        }

        with patch("flow_sdk.cli.commands._common.local_post") as mock_post:
            mock_post.return_value = MagicMock(
                status_code=200,
                text='{"data": {}}',
                json=MagicMock(return_value={"data": {}}),
            )

            result = runner.invoke(
                app,
                ["hooks", "report", "--name", "test", "--wait-for-response"],
                input=json.dumps(hook_data),
            )

        assert result.exit_code == 0
        # No decision JSON should be in stdout — only stderr log lines
        for line in result.output.strip().splitlines():
            assert not line.strip().startswith("{"), f"Unexpected JSON in output: {line}"

    def test_hooks_report_wait_for_response_request_error_no_output(self):
        """When request fails, don't output any decision — let Claude Code decide."""
        runner = CliRunner()
        hook_data = {
            "hook_event_name": "PermissionRequest",
            "session_id": "test-session",
            "tool_name": "ExitPlanMode",
        }

        with patch("flow_sdk.cli.commands._common.local_post") as mock_post:
            import requests

            mock_post.side_effect = requests.exceptions.RequestException("Connection failed")

            result = runner.invoke(
                app,
                ["hooks", "report", "--name", "test", "--wait-for-response"],
                input=json.dumps(hook_data),
            )

        assert result.exit_code == 0
        # No decision JSON should be in stdout
        for line in result.output.strip().splitlines():
            assert not line.strip().startswith("{"), f"Unexpected JSON in output: {line}"
