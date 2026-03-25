"""
Pydantic AI Worker

Advanced worker providing direct pydantic-ai access for fine-grained control.
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
from pydantic_ai import Agent as PydanticAIAgent
from pydantic_ai.usage import RunUsage

from flow_sdk.flowpad_types.enums import WorkerTaskStatus
from flow_sdk.core.flow.flow_model import FlowModel
from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowModelRequest, FlowModelResponse
from flow_sdk.core.flow.tools import ToolCallInvocationPart

from .worker import BaseWorker, WorkerRequest, WorkerResponse, WorkerStreamEvent


def log_instructions(instructions: str) -> None:
    """Log all instructions before sending to LLM."""
    logging.info("=" * 80)
    logging.info("ALL INSTRUCTIONS READY - SENDING TO LLM")
    logging.info("=" * 80)
    logging.info(instructions)
    logging.info("=" * 80)


class PydanticAIWorker(BaseWorker):
    """Advanced worker with direct pydantic-ai access."""

    _work_agent: PydanticAIAgent[ComputeSession, str] | None = None

    async def execute_task(self, request: WorkerRequest) -> AsyncIterator[WorkerStreamEvent]:
        ctx = request.ctx

        try:
            async with self.work_agent(request) as work_agent:
                async with work_agent.iter(
                    request.prompt,
                    message_history=ctx.state.agent_message_history,
                    deps=ctx.deps,
                    usage_limits=request.usage_limits,
                ) as work_run:
                    async for work_node in work_run:
                        if PydanticAIAgent.is_model_request_node(work_node):
                            # A model request node => We can stream tokens from the model's request
                            logging.info("=== ModelRequestNode: streaming partial request tokens ===")
                            async with work_node.stream(work_run.ctx) as request_stream:
                                async for event in request_stream:
                                    if event.event_kind == "part_start":
                                        self.recorded_parts.append(event.part)
                                        yield event.part
                                    elif event.event_kind == "part_delta":
                                        # Record text from deltas as they stream
                                        if hasattr(event.delta, "content_delta"):
                                            self.recorded_text += event.delta.content_delta
                                        if hasattr(event.delta, "args_delta"):
                                            self.recorded_text += event.delta.args_delta
                                        yield event.delta
                        elif PydanticAIAgent.is_call_tools_node(work_node):
                            # A handle-response node => The model returned some data, potentially calls a tool
                            logging.info("=== CallToolsNode: streaming partial response & tool usage ===")
                            async with work_node.stream(work_run.ctx) as handle_stream:
                                async for event in handle_stream:
                                    if event.event_kind == "function_tool_call":
                                        tool_call_invocation = ToolCallInvocationPart.from_tool_call_part(event.part)
                                        self.recorded_parts.append(tool_call_invocation)
                                        yield tool_call_invocation
                                    elif event.event_kind == "function_tool_result":
                                        if event.result.part_kind == "tool-return":
                                            self.recorded_parts.append(event.result)
                                            yield event.result

                                            # Check if flow stop was requested (e.g., by stop_on_skill flag)
                                            if ctx.deps.should_stop:
                                                logging.info(f"Flow stop requested: {ctx.deps.stop_reason}")
                                                worker_response = WorkerResponse(
                                                    new_messages=[],
                                                    run_usage=work_run.usage(),
                                                    status=WorkerTaskStatus.COMPLETED,
                                                    stop_reason=ctx.deps.stop_reason,
                                                )
                                                self.recorded_parts.append(worker_response)
                                                yield worker_response
                                                return
                        elif PydanticAIAgent.is_end_node(work_node):
                            if not work_run.result:
                                raise ValueError("No result available")
                            new_messages = work_run.result.new_messages()
                            worker_response = WorkerResponse(
                                new_messages=[
                                    FlowModelResponse.from_model_response(m)
                                    if m.kind == "response"
                                    else FlowModelRequest.from_model_request(
                                        m, mode=ctx.state.current_mode, timestamp_override=ctx.deps.last_prompt_time
                                    )
                                    for m in new_messages
                                ],
                                run_usage=work_run.usage(),
                                status=WorkerTaskStatus.COMPLETED,
                            )
                            self.recorded_parts.append(worker_response)
                            yield worker_response
        except asyncio.CancelledError:
            logging.info("AchieveGoal.run cancelled gracefully")
            if work_run:
                # TODO On Cancellation, history is not saved. We have to take care of broken msgs that mess the history that cause other exceptions.
                agent_run_ctx = work_run.ctx
                new_messages = agent_run_ctx.state.message_history[agent_run_ctx.deps.new_message_index :]
                # Yield the remaining messages
                yield WorkerResponse(
                    new_messages=[],
                    run_usage=RunUsage(),
                    status=WorkerTaskStatus.CANCELLED,
                )
            raise
        except Exception as e:
            logging.error(f"PydanticAIWorker execute task error: {e}")
            raise

    @asynccontextmanager
    async def work_agent(self, request: WorkerRequest):
        if self._work_agent:
            yield self._work_agent
            return

        deps = request.ctx.deps
        model = deps.agent.agent_config.llm.model if deps.agent.agent_config.llm else None

        # Collect all MCP toolsets
        toolsets = [
            deps.mcp_connector.shell_mcp_server(env={e.name: e.value.get_secret_value() for e in deps.env}),
        ]

        # Add external MCP servers if any
        if deps.external_mcp_servers:
            toolsets.extend(deps.external_mcp_servers.values())

        # # Get and print instructions before creating agent
        # instructions = await request.instructions_method()
        # # Keep this for debug purposes
        # log_instructions(instructions)

        self._work_agent = PydanticAIAgent[ComputeSession, str](
            model=FlowModel(model=model),
            instructions=request.instructions_method,
            toolsets=toolsets,
            deps_type=ComputeSession,
            tools=deps.get_tools(),
            history_processors=deps._history_processors,
        )

        try:
            async with deps.mcp_connector.fs_mcp_server, self._work_agent:
                yield self._work_agent
        except (httpx.HTTPStatusError, TimeoutError) as e:
            logging.info(f"{type(e)} occurred, reopening mcp servers")
            # If the mcp servers are not running, reopen them
            await deps.mcp_connector.reopen_mcp_servers()
            async with deps.mcp_connector.fs_mcp_server, self._work_agent:
                yield self._work_agent
        except BaseExceptionGroup as e:
            if not any(isinstance(sub_exc, TimeoutError) for sub_exc in e.exceptions) and not any(
                isinstance(sub_exc, httpx.HTTPStatusError) and sub_exc.response.status_code == 502
                for sub_exc in e.exceptions
            ):
                raise
            logging.info("TimeoutError occurred internally, reopening mcp servers")
            await deps.mcp_connector.reopen_mcp_servers()
            async with deps.mcp_connector.fs_mcp_server, self._work_agent:
                yield self._work_agent
