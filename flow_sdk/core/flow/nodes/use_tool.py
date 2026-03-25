import json
import logging
from dataclasses import dataclass
from typing import Annotated

from pydantic_ai.messages import TextPart, ToolCallPart, ToolReturnPart, UserPromptPart
from pydantic_graph import BaseNode, Edge, GraphRunContext

from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowModelRequest, FlowModelResponse, FlowState
from flow_sdk.core.flow.nodes.wait_for_human_input import WaitForHumanInput
from flow_sdk.core.flow.tools import ToolCallInvocationPart


@dataclass
class UseTool(BaseNode[FlowState, ComputeSession]):
    user_prompt: str

    async def run(
        self, ctx: GraphRunContext[FlowState, ComputeSession]
    ) -> Annotated[WaitForHumanInput, Edge(label="Tool Executed")]:
        logging.info("--- Using Tool ---")

        async with ctx.deps.mcp_connector.initialize():
            # Parse the command: "/<tool_name> <args>"
            tool_parts = self.user_prompt.strip().split(maxsplit=1)
            if len(tool_parts) < 2:
                raise ValueError("Invalid command format. Use: /<tool_name> <args...>")

            tool_name = (tool_parts[0])[1:]
            args = tool_parts[1] if len(tool_parts) == 2 else None

            logging.info(f"Executing tool: {tool_name} with args: {args}")

            if args is None:
                raise ValueError(f"No arguments provided for {tool_name} tool.")

            if tool_name == "shell":
                await self._run_shell_tool(ctx, tool_name, args)
            elif tool_name == "fs":
                await self._run_fs_tool(ctx, args)
            else:
                raise ValueError(f"Tool {tool_name} is not supported.")

            logging.info(f"Tool executed successfully: {tool_name} {args}")

            return WaitForHumanInput()

    async def _run_shell_tool(self, ctx: GraphRunContext[FlowState, ComputeSession], tool_name: str, args: str):
        user_prompt_part = UserPromptPart(content=self.user_prompt)
        tool_call_part = ToolCallPart(
            tool_name, {"command": args, "timeout": 120000}, tool_call_id=f"manual_{tool_name}_{hash(self.user_prompt)}"
        )

        # Notify the tool box about the tool call
        await ctx.deps.tool_box.on_tool_call_invocation(ToolCallInvocationPart.from_tool_call_part(tool_call_part))

        # Execute the tool based on tool name
        result = await self._call_shell_mcp_tool(ctx, tool_call_part)

        # Create a ToolReturnPart for the result
        tool_return_part = ToolReturnPart(
            tool_call_id=tool_call_part.tool_call_id,
            part_kind="tool-return",
            tool_name=tool_name,
            content=result,
        )

        # Notify the tool box about the tool result
        await ctx.deps.tool_box.on_tool_result(tool_return_part)

        ctx.state.message_history += [
            FlowModelRequest(parts=[user_prompt_part]),
            FlowModelResponse(parts=[tool_call_part]),
            FlowModelRequest(parts=[tool_return_part]),
        ]

    async def _call_shell_mcp_tool(self, ctx: GraphRunContext[FlowState, ComputeSession], tool_call_part: ToolCallPart):
        """Execute a shell command using the shell MCP server with progress streaming."""
        shell_server = ctx.deps.mcp_connector.shell_mcp_server(
            env={e.name: e.value.get_secret_value() for e in ctx.deps.env}
        )

        # Progress callback that extracts stdout/stderr from JSON progress and forwards to callback handler
        async def progress_callback(progress: float, total: float | None, message: str | None) -> None:
            if message:
                try:
                    data = json.loads(message)
                    # Extract stdout and stderr from the progress JSON
                    stdout = data.get("stdout", "")
                    stderr = data.get("stderr", "")
                    # Forward any output to the callback handler using proper shell-output element type
                    if stdout:
                        await ctx.deps.callback_handler.on_shell_output(stdout, "stdout")
                    if stderr:
                        await ctx.deps.callback_handler.on_shell_output(stderr, "stderr")
                except json.JSONDecodeError:
                    # If not JSON, forward as chat (non-shell progress message)
                    await ctx.deps.callback_handler.on_new_chunk(message)

        # Execute the command using the shell server with progress-aware timeout
        async with shell_server:
            result = await shell_server.call_tool_with_progress_timeout(
                name=tool_call_part.tool_name,
                arguments=tool_call_part.args_as_dict(),
                progress_callback=progress_callback,
            )
            logging.info(f"Shell command result: {result}")
            return result

    async def _run_fs_tool(self, ctx: GraphRunContext[FlowState, ComputeSession], args: str):
        action, path_content = args.split(maxsplit=1)
        if action != "write":
            raise ValueError(f"Unsupported fs command: {action}. Only 'write' is supported.")

        user_prompt_part = UserPromptPart(content=self.user_prompt.split("\n", maxsplit=1)[0])

        file_path, file_content = path_content.split("\n", maxsplit=1)
        text_part = TextPart(content=f'<flow-write path="{file_path}">\n{file_content}\n</flow-write>')
        await ctx.deps.tool_box.on_part_start(text_part)

        ctx.state.message_history += [
            FlowModelRequest(parts=[user_prompt_part]),
            FlowModelResponse(parts=[text_part]),
        ]
