"""Agent for executing completion requests and managing conversation flows."""

from typing import Optional, Union

from flow_sdk.core.flow.models.flow_data import FlowData, FlowDataType, FlowElementType
from flow_sdk.core.flow.models.state.flow_state import FlowMode, FlowState


class CompletionRequest:
    """Request to execute a completion task."""

    def __init__(self, message: str, flow_mode: FlowMode = FlowMode.AUTO):
        """
        Initialize a completion request.

        Args:
            message: The user message to process
            flow_mode: Execution mode (AUTO, ASK, AGENT)
        """
        self.message = message
        self.flow_mode = flow_mode


class Agent:
    """
    Agent for executing completion requests and managing conversation flows.

    The agent maintains conversation state across multiple executions via FlowState,
    allowing for multi-turn interactions while tracking all responses.

    Uses the existing Flow infrastructure:
    - FlowState: Tracks message history and checkpoints
    - FlowData: Individual response elements
    - FlowMode: Execution mode selection
    """

    def __init__(self, config: Optional[dict] = None):
        """
        Initialize the agent.

        Args:
            config: Optional agent configuration (model, tokens, etc.)
        """
        self.config = config or {}

    def execute(
        self,
        request: Union[CompletionRequest, str],
        flow: Optional[FlowState] = None,
    ) -> FlowState:
        """
        Execute a completion request.

        Supports two modes:
        1. New execution: request is CompletionRequest, creates new FlowState
        2. Continuation: request is string, appends to existing FlowState

        Args:
            request: Either CompletionRequest for new task or string to continue
            flow: Optional FlowState to continue. Required if request is a string.

        Returns:
            FlowState with accumulated responses

        Raises:
            ValueError: If continuing with string but no flow provided
        """
        if isinstance(request, str):
            # Continuing existing conversation
            if flow is None:
                raise ValueError(
                    "FlowState is required when continuing with a message string"
                )
            message = request
            flow_mode = FlowMode.AGENT  # Default continuation mode
            flow_state = flow
        else:
            # Starting new execution
            message = request.message
            flow_mode = request.flow_mode
            flow_state = FlowState()

        # Update flow mode if needed
        if flow_state.chat_options and hasattr(flow_state.chat_options.mode, 'value'):
            flow_state.chat_options.mode.value = flow_mode

        # Process the message and generate response
        response_text = self._process_message(message)

        # Create FlowData for the response
        response_data = FlowData(
            flow_value=response_text,
            attributes={
                "element-type": FlowElementType.CHAT,
                "data-type": FlowDataType.TEXT,
            }
        )

        # Add to flow checkpoints (accumulates responses)
        flow_state.checkpoint_items.append(response_data)

        return flow_state

    def _process_message(self, message: str) -> str:
        """
        Process a message and return response.

        In a real implementation, this would:
        1. Initialize Claude SDK with config
        2. Execute prompt via MCP servers (shell, filesystem)
        3. Stream responses via callback handler
        4. Return final response

        Currently delegates to a stub implementation.

        Args:
            message: User message to process

        Returns:
            Response text
        """
        # Stub implementation
        return f"Agent response to: {message}"

    def __repr__(self) -> str:
        return f"Agent(config={self.config})"
