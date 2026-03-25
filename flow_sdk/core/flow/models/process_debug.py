"""Debug functionality for process execution."""

from .process_deps import ComputeSession
from .state.flow_state import FlowPhase, FlowState


def debug_process(process_session: ComputeSession) -> None:
    """Initialize debug mode by setting first breakpoint."""
    # Store debug settings in process_session temporarily until state is initialized
    process_session._debug_mode = True
    process_session._initial_breakpoint = FlowPhase.PLANNING


async def step(process_session: ComputeSession, user_prompt: str) -> bool:
    """
    Execute one debug step.

    Args:
        process_session: The process execution dependencies
        user_prompt: The original user prompt to continue with

    Returns:
        bool: True if more steps available, False if completed/error
    """

    set_next_breakpoint(process_session.flow.state)

    from ..process_execution import execute_process

    await execute_process(user_prompt, process_session)

    # Check if execution completed
    is_complete = process_session.flow.state.flow_phase in [FlowPhase.COMPLETED, FlowPhase.ERROR]

    # Clear debug mode when execution finishes
    if is_complete and hasattr(process_session, "_debug_mode"):
        process_session._debug_mode = False

    return not is_complete


def set_next_breakpoint(process_state: FlowState) -> None:
    """Set breakpoint for next logical phase."""
    current = process_state.flow_phase

    if current == FlowPhase.INITIAL:
        process_state.breakpoint = FlowPhase.PLANNING
    elif current == FlowPhase.PLANNING:
        process_state.breakpoint = FlowPhase.EXECUTING
    elif current == FlowPhase.EXECUTING:
        process_state.breakpoint = FlowPhase.REPORTING
    elif current == FlowPhase.REPORTING:
        process_state.breakpoint = FlowPhase.COMPLETED
    elif current in [FlowPhase.COMPLETED, FlowPhase.ERROR]:
        process_state.breakpoint = None


def is_debug_mode(process_session: ComputeSession) -> bool:
    """Check if process is in debug mode."""
    # Check if process state has debug breakpoint
    if process_session.flow.state:
        return process_session.flow.state.breakpoint is not None
    # Check if debug mode was set before execution (fallback)
    if hasattr(process_session, "_debug_mode"):
        return process_session._debug_mode
    return False
