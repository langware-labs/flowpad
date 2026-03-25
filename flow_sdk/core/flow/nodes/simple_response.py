import logging
from dataclasses import dataclass
from typing import Annotated

from pydantic_ai import Agent as PydanticAIAgent
from pydantic_ai.usage import UsageLimits
from pydantic_graph import BaseNode, Edge, GraphRunContext

from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowModelRequest, FlowModelResponse, FlowState
from flow_sdk.core.flow.nodes.wait_for_human_input import WaitForHumanInput


@dataclass
class SimpleResponse(BaseNode[FlowState, ComputeSession]):
    user_prompt: str

    async def run(
        self, ctx: GraphRunContext[FlowState, ComputeSession]
    ) -> Annotated[WaitForHumanInput, Edge(label="Human Input")]:
        logging.info("--- Answer Question ---")
        await ctx.deps.callback_handler.on_trace("Starting simple response flow")

        # Check if classify_only mode is enabled - skip LLM call and return immediately
        if ctx.deps.completion_request and ctx.deps.completion_request.classify_only:
            logging.info("classify_only mode: skipping LLM call and returning immediately")
            await ctx.deps.callback_handler.on_llm_end()
            return WaitForHumanInput()

        await ctx.deps.callback_handler.on_status("Thinking...")
        # Use context-aware tool box for artifact tracking
        tool_box = ctx.deps.get_tool_box_for_context(ctx)
        async with ctx.deps.simple_agent(self.user_prompt) as simple_agent:
            async with simple_agent.iter(
                self.user_prompt,
                message_history=ctx.state.agent_message_history,
                deps=ctx.deps,
                usage=ctx.state.run_usage,
                usage_limits=UsageLimits(request_limit=None),
            ) as simple_run:
                async for simple_node in simple_run:
                    if PydanticAIAgent.is_model_request_node(simple_node):
                        async with simple_node.stream(simple_run.ctx) as request_stream:
                            async for event in request_stream:
                                if event.event_kind == "part_start":
                                    await tool_box.on_part_start(event.part)
                                elif event.event_kind == "part_delta":
                                    await tool_box.on_part_delta(event.delta)
                    elif PydanticAIAgent.is_end_node(simple_node):
                        if not simple_run.result:
                            raise ValueError("No result available")
                        # Once an End node is reached, the agent run is complete
                        all_messages = simple_run.result.new_messages()
                        ctx.state.message_history += [
                            FlowModelResponse.from_model_response(m)
                            if m.kind == "response"
                            else FlowModelRequest.from_model_request(
                                m, mode=ctx.state.current_mode, timestamp_override=ctx.deps.last_prompt_time
                            )
                            for m in all_messages
                        ]
                        await ctx.deps.callback_handler.on_llm_end()
                        ctx.state.run_usage = simple_run.usage()

        await ctx.deps.callback_handler.on_trace("Simple response completed")
        return WaitForHumanInput()
