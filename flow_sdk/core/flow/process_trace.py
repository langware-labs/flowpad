"""Process trace logging utilities."""

import logging

from pydantic_graph import GraphRunContext

from flow_sdk.flowpad_types.enums import TraceLevel, TraceType
from flow_sdk.core.flow.models import FlowState
from flow_sdk.core.flow.models.process_deps import ComputeSession
from flow_sdk.core.flow.models.state.flow_state import FlowPhase
from flow_sdk.shared import PhaseTransitionData, TraceItem


async def trace_log(ctx: GraphRunContext[FlowState, ComputeSession], trace: TraceItem):
    """Log a trace item and stream to frontend."""
    # Stream to frontend
    await ctx.deps.callback_handler.on_trace_item(trace)

    # Server-side logging
    if trace.level == TraceLevel.ERROR:
        logging.error(trace.message)
    elif trace.level == TraceLevel.WARNING:
        logging.warning(trace.message)
    else:
        logging.info(trace.message)

    # Add to state
    ctx.state.trace_items.append(trace)


async def info(ctx: GraphRunContext[FlowState, ComputeSession], message: str):
    """Log an info trace."""
    trace = TraceItem(type=TraceType.CHAT, level=TraceLevel.INFO, message=message)
    await trace_log(ctx, trace)


async def warning(ctx: GraphRunContext[FlowState, ComputeSession], message: str):
    """Log a warning trace."""
    trace = TraceItem(type=TraceType.CHAT, level=TraceLevel.WARNING, message=message)
    await trace_log(ctx, trace)


async def error(ctx: GraphRunContext[FlowState, ComputeSession], message: str):
    """Log an error trace."""
    trace = TraceItem(type=TraceType.ERROR, level=TraceLevel.ERROR, message=message)
    await trace_log(ctx, trace)


async def phase_transition(
    ctx: GraphRunContext[FlowState, ComputeSession],
    from_phase: FlowPhase,
    to_phase: FlowPhase,
    current_todo=None,
):
    """Log a phase transition."""
    # Create message
    message = f"Process phase transitioned from {from_phase.value.upper()} to {to_phase.value.upper()}"

    # Create trace with typed data
    data = PhaseTransitionData(
        from_phase=from_phase.value,
        to_phase=to_phase.value,
        current_todo=None,
    )

    trace = TraceItem[PhaseTransitionData](
        type=TraceType.PHASE_TRANSITION,
        level=TraceLevel.INFO,
        message=message,
        data=data,
    )
    trace.summary = trace.compute_summary()

    await trace_log(ctx, trace)
