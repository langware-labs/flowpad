"""OpsActionsMixin — compute node ops dispatcher and command execution for ComputeNode.

Mixed into ComputeNode. Accesses self.compute_provider, self.node_provider_id,
self.node_config, self.id, self.resume() via normal Python attribute lookup.
"""
from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from starlette.responses import StreamingResponse

from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType, ViewType
from flow_sdk.core.flow.streaming.response_handler import StreamingResponseHandler
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


class OpsActionsMixin:
    """ops dispatcher and command execution implementation for ComputeNode.

    All methods here are plain implementations — no @action decorators.
    ComputeNode keeps the @action stub and delegates to _ops_dispatch().
    """

    async def _setup_op(self) -> ApiResponse:
        """Setup the compute node."""
        from flow_sdk.builtin.compute_node import ComputeNode
        try:
            # Reload the node from DB to ensure all fields are hydrated
            hydrated: ComputeNode = await ComputeNode.get_by_id(self.id)
            if not hydrated:
                return ApiFailResponse(message="Compute node not found in DB.")
            provider_node_id = await hydrated.setup_node()
            await hydrated.save()
            return ApiSuccessResponse(data=provider_node_id)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _startup_op(self) -> ApiResponse:
        """Start the compute node."""
        if not self.node_provider_id:
            provider_node_id = await self.setup_node()
            self.node_provider_id = provider_node_id
            await self.save()
        try:
            if not isinstance(self.node_provider_id, str):
                return ApiFailResponse(message="Failed to setup compute node. No provider node ID returned.")
            result = await self.compute_provider.startup(self.node_provider_id, self.node_config)
            if not result:
                return ApiFailResponse(message="Failed to start compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _shutdown_op(self) -> ApiResponse:
        """Shutdown the compute node."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to shutdown")
        try:
            result = await self.compute_provider.shutdown(self.node_provider_id)
            if not result:
                return ApiFailResponse(message="Failed to shutdown compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _pause_op(self) -> ApiResponse:
        """Pause the compute node immediately (user-initiated pause)."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to pause")
        try:
            # Use immediate=True for user-initiated pause via API
            result = await self.compute_provider.pause(self.node_provider_id, immediate=True)
            if not result:
                return ApiFailResponse(message="Failed to pause compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _setup_lm_proxy_op(self) -> ApiResponse:
        """Setup LM proxy access for the compute node."""
        from flow_sdk.builtin.compute_node import ComputeNode
        try:
            # Reload the node from DB to ensure all fields are hydrated
            hydrated: ComputeNode = await ComputeNode.get_by_id(self.id)
            if not hydrated:
                return ApiFailResponse(message="Compute node not found in DB.")
            api_key = await hydrated.setup_lm_proxy_access()
            return ApiSuccessResponse(data={"message": "LM proxy access configured", "key_prefix": api_key[:8] + "..."})
        except Exception as e:
            import traceback

            logging.error(f"_setup_lm_proxy_op error: {e}\n{traceback.format_exc()}")
            return ApiFailResponse(message=str(e))

    async def _resume_op(self) -> ApiResponse:
        """Resume the compute node."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to resume")
        try:
            result = await self.compute_provider.resume(self.node_provider_id)
            if not result:
                return ApiFailResponse(message="Failed to resume compute node")
            return ApiSuccessResponse(data=result)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _get_metrics_op(self) -> ApiResponse:
        """Get metrics for the compute node (E2B only)."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")
        try:
            metrics = await self.compute_provider.get_metrics(self.node_provider_id)
            return ApiSuccessResponse(data=metrics)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _get_logs_op(self) -> ApiResponse:
        """Get logs for the compute node (E2B only)."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set")
        try:
            request_info = get_current_request_info()
            limit = 100
            if request_info and request_info.request:
                body = await request_info.get_post_data()
                if isinstance(body, dict):
                    limit = body.get("limit", 100)

            logs = await self.compute_provider.get_logs(self.node_provider_id, limit)
            return ApiSuccessResponse(data=logs)
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _command_op(self) -> ApiResponse | StreamingResponse:
        """Execute a command on the compute node."""
        if not self.node_provider_id:
            return ApiFailResponse(message="Compute node provider ID not set. Nothing to execute command on")
        try:
            request_info = get_current_request_info()
            if not request_info or not request_info.request:
                return ApiFailResponse(message="No request info or request object available")

            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid command data (expected JSON object body)")

            command = body.get("command")
            if not command:
                return ApiFailResponse(message="No command provided")

            session_id = body.get("session_id")
            stream = body.get("stream", True)  # Enable streaming by default for real-time output

            # Generate unique group_id for this command execution
            # This is used by FlowStreamProcessor on the frontend to merge streaming FlowData chunks
            # that belong to the same logical group (stdout/stderr/exit-code for this command)
            temp_flow_data = FlowData(flow_value="", attributes={})
            group_id = temp_flow_data.generate_group_id()

            # If streaming requested, use streaming path
            if stream:
                stream_handler = StreamingResponseHandler()
                cmd_task = asyncio.create_task(
                    self._execute_streaming_command(command, session_id, group_id, stream_handler)
                )
                return self._create_command_streaming_response(cmd_task, stream_handler)

            # Non-streaming path (current behavior)
            # Try to execute command, with automatic recovery if sandbox is not found
            # Use background=False for interactive terminal commands to ensure output is captured
            try:
                cmd = await self.compute_provider.run_command(
                    self.node_provider_id, command, session_id, background=False
                )
            except Exception as exec_error:
                error_msg = str(exec_error)
                # Check if sandbox/node was not found or is paused
                if "not found" in error_msg.lower() or "paused" in error_msg.lower():
                    try:
                        # Try to resume the compute node
                        await self.resume()
                        # Retry command execution
                        cmd = await self.compute_provider.run_command(
                            self.node_provider_id, command, session_id, background=False
                        )
                    except Exception as resume_error:
                        return ApiFailResponse(
                            message=f"Compute node unavailable. Please ask the agent to start a new session."
                            f" Error: {str(resume_error)}"
                        )
                else:
                    raise exec_error

            if not cmd:
                return ApiFailResponse(message="Failed to execute command")

            # Wait for command completion with longer timeout for interactive terminals
            is_complete = await cmd.wait(timeout=30.0)
            if not is_complete:
                return ApiFailResponse(message="Command did not complete within timeout")

            # Return result as XML FlowData using new format
            # Build XML response with proper channel chunks
            xml_chunks = []

            # Send stdout chunk with channel attribute if there's stdout
            if cmd.all_stdout:
                stdout_flow_data = FlowData(
                    flow_value=cmd.all_stdout,
                    attributes={
                        "element-type": FlowElementType.SHELL_OUTPUT,
                        "data-type": FlowDataType.TEXT,
                        "group-id": group_id,
                        "channel": "stdout",
                    },
                    focus="shell",
                )
                xml_chunks.append(stdout_flow_data.to_xml)

            # Send stderr chunk with channel attribute if there's stderr
            if cmd.all_stderr:
                stderr_flow_data = FlowData(
                    flow_value=cmd.all_stderr,
                    attributes={
                        "element-type": FlowElementType.SHELL_OUTPUT,
                        "data-type": FlowDataType.TEXT,
                        "group-id": group_id,
                        "channel": "stderr",
                    },
                    focus="shell",
                )
                xml_chunks.append(stderr_flow_data.to_xml)

            # Send group-level final chunk with exit-code (no channel attribute)
            final_flow_data = FlowData(
                flow_value="",  # Empty content - data is in attributes
                attributes={
                    "element-type": FlowElementType.SHELL_OUTPUT,
                    "data-type": FlowDataType.TEXT,
                    "group-id": group_id,
                    "exit-code": str(cmd.exit_code),
                    "stdout": cmd.all_stdout,  # Fallback for clients
                    "stderr": cmd.all_stderr,  # Fallback for clients
                    "final": "true",  # Flag indicating group completion
                },
            )
            xml_chunks.append(final_flow_data.to_xml)

            return ApiSuccessResponse(data="".join(xml_chunks))
        except Exception as e:
            return ApiFailResponse(message=str(e))

    async def _execute_streaming_command(
        self, command: str, session_id: str | None, group_id: str, callback_handler: StreamingResponseHandler
    ) -> None:
        """Execute command in background and stream output chunks to callback handler."""
        try:
            # Ensure shell focus before streaming output
            await callback_handler.on_focus(ViewType.SHELL)

            # Run command in background mode for streaming
            cmd = await self.compute_provider.run_command(self.node_provider_id, command, session_id, background=True)

            # Stream stdout chunks using FlowData with channel attribute
            async def stream_stdout():
                async for line in cmd.stdout_stream():
                    stdout_flow_data = FlowData(
                        flow_value=line,
                        attributes={
                            "element-type": FlowElementType.SHELL_OUTPUT,
                            "data-type": FlowDataType.TEXT,
                            "group-id": group_id,
                            "channel": "stdout",
                        },
                        focus="shell",
                    )
                    logging.info(f"[STREAM_STDOUT] Sending: {stdout_flow_data.to_xml[:200]}")
                    await callback_handler.on_flow_data(stdout_flow_data)

            # Stream stderr chunks using FlowData with channel attribute
            async def stream_stderr():
                async for line in cmd.stderr_stream():
                    stderr_flow_data = FlowData(
                        flow_value=line,
                        attributes={
                            "element-type": FlowElementType.SHELL_OUTPUT,
                            "data-type": FlowDataType.TEXT,
                            "group-id": group_id,
                            "channel": "stderr",
                        },
                        focus="shell",
                    )
                    logging.info(f"[STREAM_STDERR] Sending: {stderr_flow_data.to_xml[:200]}")
                    await callback_handler.on_flow_data(stderr_flow_data)

            # Run both streams concurrently
            await asyncio.gather(stream_stdout(), stream_stderr())

            # Wait for command completion
            await cmd.wait(timeout=30.0)

            # Send group-level final chunk with exit-code (no channel attribute)
            final_flow_data = FlowData(
                flow_value="",  # Empty content - data is in attributes
                attributes={
                    "element-type": FlowElementType.SHELL_OUTPUT,
                    "data-type": FlowDataType.TEXT,
                    "group-id": group_id,
                    "exit-code": str(cmd.exit_code),
                    "final": "true",  # Flag indicating group completion
                },
            )
            logging.info(f"Sending final FlowData: {final_flow_data.to_xml[:200]}")
            await callback_handler.on_flow_data(final_flow_data)

            logging.info("Sending end-of-stream signal")
            # Signal end of stream
            await callback_handler.on_flow_data(None)

        except Exception as e:
            logging.error(f"Error in _execute_streaming_command: {e}")
            # Send error as flow data
            error_flow_data = FlowData(
                flow_value=str(e),
                attributes={
                    "element-type": FlowElementType.SHELL_OUTPUT,
                    "data-type": FlowDataType.TEXT,
                    "group-id": group_id,
                    "error": "true",
                },
            )
            await callback_handler.on_flow_data(error_flow_data)
            # Signal end of stream even on error
            await callback_handler.on_flow_data(None)

    @staticmethod
    def _create_command_streaming_response(
        cmd_task: asyncio.Task[None],
        stream_handler: StreamingResponseHandler,
    ) -> StreamingResponse:
        """Create streaming response for command execution."""

        async def stream_response():
            counter = 0
            try:
                async for xml_chunk in stream_handler:
                    counter += 1
                    logging.debug(f"Yielding chunk {counter}: {xml_chunk[:100]}")
                    yield xml_chunk
            except Exception as e:
                logging.error(f"Error in stream_response iteration: {e}")

            # Ensure task completes
            if not cmd_task.done():
                logging.info("Waiting for command task to complete...")
                await cmd_task

            logging.info(f"Command task completed, total chunks: {counter}")

        return StreamingResponse(
            stream_response(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    async def _ops_dispatch(self):
        """Dispatch compute operations via /ops/<op> API. sub_path is the operation (startup, shutdown, etc.)."""
        request_info = get_current_request_info()
        if not request_info or not request_info.sub_path:
            return ApiFailResponse(message="No operation specified")

        op = request_info.sub_path.strip("/").lower()
        try:
            if op == "setup":
                return await self._setup_op()
            elif op == "startup":
                return await self._startup_op()
            elif op == "shutdown":
                return await self._shutdown_op()
            elif op == "pause":
                return await self._pause_op()
            elif op == "resume":
                return await self._resume_op()
            elif op == "command":
                return await self._command_op()
            elif op == "setup-lm-proxy":
                return await self._setup_lm_proxy_op()
            elif op == "metrics":
                return await self._get_metrics_op()
            elif op == "logs":
                return await self._get_logs_op()
            else:
                return ApiFailResponse(message=f"Unknown operation: {op}")
        except Exception as e:
            return ApiFailResponse(message=str(e))

