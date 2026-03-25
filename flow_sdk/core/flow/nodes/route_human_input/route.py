# ruff: noqa
import logging
from dataclasses import dataclass
from typing import Annotated

from pydantic_graph import BaseNode, Edge, GraphRunContext

from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowMode, FlowPhase, FlowState
from flow_sdk.core.flow.nodes.simple_response import SimpleResponse
from flow_sdk.core.flow.nodes.use_tool import UseTool
from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType

from .classify_first_request import RequestClassification, classify_first_request
from .classify_request import classify_request


async def is_debug_redirect(ctx: GraphRunContext[FlowState, ComputeSession], user_prompt: str) -> SimpleResponse | None:
    """Handle debug mode initialization and resume. Returns None if no redirect needed, otherwise returns the node to redirect to."""
    # Handle debug mode initialization and resume
    if hasattr(ctx.deps, "_debug_mode") and ctx.deps._debug_mode:
        from flow_sdk.core.flow import process_trace

        # Preserve existing breakpoint if already set, otherwise use initial breakpoint
        if ctx.state.breakpoint is None:
            ctx.state.breakpoint = getattr(ctx.deps, "_initial_breakpoint", FlowPhase.PLANNING)
        old_phase = ctx.state.flow_phase
        ctx.state.flow_phase = FlowPhase.INITIAL
        await process_trace.phase_transition(ctx, old_phase, FlowPhase.INITIAL)
        logging.info(f"🐛 Debug mode initialized: breakpoint={ctx.state.breakpoint}, phase={ctx.state.flow_phase}")

    # Handle debug resume - if we're resuming from a breakpoint, route to simple response
    if ctx.state.debug_paused_at:
        paused_at = ctx.state.debug_paused_at
        ctx.state.debug_paused_at = None  # Clear the pause state
        logging.info(f"🐛 Debug resuming from: {paused_at.value}")
        return SimpleResponse(user_prompt=user_prompt)

    return None


def get_request_classification_context(ctx: GraphRunContext[FlowState, ComputeSession]) -> str:
    """Build context string from current flow state for classification."""
    context_parts = []

    if ctx.state.flow_phase:
        context_parts.append(f"Current phase: {ctx.state.flow_phase.value}")

    return " | ".join(context_parts) if context_parts else ""


async def process_user_request(ctx: GraphRunContext[FlowState, ComputeSession], user_prompt: str) -> None:
    """Process user request by classifying mode if needed, updating chat_options state."""
    # Check if execution flow is disabled
    execution_enabled = ctx.deps.agent.agent_config.execution_enabled if ctx.deps.agent.agent_config else True
    if not execution_enabled:
        logging.info("Execution flow is disabled, giving simple response.")
        ctx.state.chat_options.mode.set_model_choice(FlowMode.ASK)
        return
    if ctx.deps.completion_request:
        ctx.state.chat_options.search = ctx.deps.completion_request.enable_search
        ctx.state.chat_options.mode.value = ctx.deps.completion_request.flow_mode
        ctx.state.chat_options.labels.value = ctx.deps.completion_request.labels

    needs_mode_classification = ctx.state.chat_options.mode.value == FlowMode.AUTO

    if not needs_mode_classification:
        return

    if not (ctx.deps.completion_request and ctx.deps.completion_request.classify_planner_supported):
        logging.info("classify_is_planner_supported is false, classifying using hardcoded values.")
        ctx.state.chat_options.mode.set_model_choice(FlowMode.AGENT)
        return
    try:
        context = get_request_classification_context(ctx)

        if ctx.state.chat_options.mode.model_choice is None:
            classification = await classify_first_request(user_prompt, context)
        else:
            classification = await classify_request(user_prompt, context)

        if needs_mode_classification:
            last_mode_choice = ctx.state.chat_options.mode.model_choice
            ctx.state.chat_options.mode.set_model_choice(classification.mode)
            if classification.mode != last_mode_choice:
                # Update labels from classification
                current_model_labels = ctx.state.chat_options.labels.model_choice or []
                new_labels = list(current_model_labels)
                for label in classification.labels:
                    if label not in new_labels:
                        new_labels.append(label)
                ctx.state.chat_options.labels.set_model_choice(new_labels)
                await ctx.deps.callback_handler.on_state("chat_options", ctx.state.chat_options.model_dump())

    except Exception as e:
        logging.exception("Error during classification")
        try:
            error_data = FlowData(
                element_type=FlowElementType.ERROR,
                data_type=FlowDataType.TEXT,
                content=f"Classification error: {str(e)}",
            )
            await ctx.deps.callback_handler.on_flow_data(error_data)
        except Exception:
            logging.exception("Failed to emit error callback")


@dataclass
class RouteHumanInput(BaseNode[FlowState, ComputeSession]):
    user_prompt: str | None = None

    async def run(
        self, ctx: GraphRunContext[FlowState, ComputeSession]
    ) -> Annotated[SimpleResponse, Edge(label="Simple Response")] | Annotated[UseTool, Edge(label="Use Tool")]:
        logging.info("--- Route Human Input ---")

        # Handle debug mode initialization and resume
        debug_redirect = await is_debug_redirect(ctx, self.user_prompt)
        if debug_redirect:
            return debug_redirect

        if self.user_prompt is None:
            raise ValueError("User prompt is required")

        # Check if this is a direct tool command (starts with "/")
        if self.user_prompt.startswith("/"):
            logging.info("Input starts with '/', routing to UseTool")
            return UseTool(user_prompt=self.user_prompt)

        # Process user request (classify mode if needed, update chat_options)
        await process_user_request(ctx, self.user_prompt)

        # Check if classify_only mode is enabled - exit early after classification
        if ctx.deps.completion_request and ctx.deps.completion_request.classify_only:
            logging.info("classify_only mode enabled, returning simple response after classification.")
            return SimpleResponse(user_prompt=self.user_prompt)

        return SimpleResponse(user_prompt=self.user_prompt)
