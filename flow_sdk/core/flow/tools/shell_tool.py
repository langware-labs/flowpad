"""Shell tool handler."""

from __future__ import annotations

from flow_sdk.core.flow.models.flow_data import ViewType
from flow_sdk.core.flow.streaming.response_handler import CallbackHandler

from .base import FlowToolHandler
from .models import ToolCallInvocationPart


class ShellToolHandler(FlowToolHandler):
    _callback_handler: CallbackHandler

    def __init__(self, callback_handler: CallbackHandler, **kwargs):
        super().__init__(**kwargs)
        self._callback_handler = callback_handler

    @property
    def callback_handler(self) -> CallbackHandler:
        return self._callback_handler

    async def on_tool_call_invocation(self, part: ToolCallInvocationPart):
        await self._callback_handler.on_focus(ViewType.SHELL)
        await self._callback_handler.on_status("Executing shell command...")
        if (
            (args_json := part.args_as_dict())
            and (workdir := args_json.get("workdir", "~"))
            and (command := args_json.get("command", None))
            and isinstance(command, str)
        ):
            await self.callback_handler.on_shell_input(command, workdir)

    async def on_tool_result(self, result):
        """Handle shell command completion.

        Note: Shell output (stdout/stderr) is already streamed via the MCP progress callback
        in mcp_server.py. We don't resend it here to avoid duplicate output.
        """
        # Shell output was already streamed via MCP progress callback
