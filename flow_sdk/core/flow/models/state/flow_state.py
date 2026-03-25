from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Annotated, Any, List, Optional, Union, cast

import pydantic
from pydantic import BaseModel, Field
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse
from pydantic_ai.usage import RunUsage
from pydantic_graph import FullStatePersistence, NodeSnapshot

from flow_sdk.config import default_service_config
from flow_sdk.core.flow.models.resolvable import Resolvable
from flow_sdk.core.flow.semantic_analyzer import UserPromptAnalysis
from flow_sdk.core.flow.models.flow_data import FlowCheckpointData

# Import TraceItem from shared module
from flow_sdk.shared import TraceItem


class ProcessorState(BaseModel):
    """Execution state for AgenticProcessor. Simple dict-serializable."""

    index: int = 0  # Current instruction index (for resume)
    variables: dict[str, Any] = Field(default_factory=dict)
    waiting_for_input: bool = False  # Paused, waiting for next user message
    input_id: Optional[str] = None  # ID of the UI/prompt waiting for input
    instruction_content: Optional[str] = None  # MDO content for resume
    stack: list[Any] = Field(default_factory=list)  # Call stack for nested blocks


class FlowPhase(Enum):
    INITIAL = "initial"
    PLANNING = "planning"  # Currently planning
    EXECUTING = "executing"  # Currently executing todo
    REPORTING = "reporting"  # Currently reporting/finalizing todo
    COMPLETED = "completed"  # All finished (past tense - terminal state)
    ERROR = "error"  # Error state (also terminal)


class FlowMode(Enum):
    ASK = "Ask"
    AGENT = "Agent"
    AUTO = "Auto"
    UNKNOWN = "Unknown"


@dataclass(repr=False)
class FlowModelRequest(ModelRequest):
    processed_message: ModelRequest | None = None
    mode: FlowMode | None = None

    @classmethod
    def from_model_request(
        cls, request: ModelRequest, mode: FlowMode | None = None, timestamp_override: datetime | None = None
    ):
        instance = cls(**vars(request))
        instance.mode = mode

        # If timestamp_override is provided, update the timestamp of user-prompt parts
        if timestamp_override is not None:
            for part in instance.parts:
                if part.part_kind == "user-prompt":
                    part.timestamp = timestamp_override

        return instance


@dataclass(repr=False)
class FlowModelResponse(ModelResponse):
    """
    Custom response type for FlowPad that can be used to handle model responses.
    This is a placeholder for any additional fields or methods specific to FlowPad responses.
    """

    processed_message: ModelResponse | None = None

    @classmethod
    def from_model_response(cls, response: ModelResponse):
        return cls(**vars(response))


FlowModelMessage = Annotated[Union[FlowModelRequest, FlowModelResponse], pydantic.Discriminator("kind")]


class ChatOptionsState(BaseModel):
    """Chat options state with resolvable mode, skill, and labels."""

    search: bool = Field(default=True, description="Enable web search")
    mode: Resolvable[FlowMode] = Field(
        default_factory=lambda: Resolvable[FlowMode](value=FlowMode.AGENT), description="Execution mode"
    )
    labels: Resolvable[list[str]] = Field(
        default_factory=lambda: Resolvable[list[str]](value=[]), description="Active topic labels for agent context"
    )
    auto_update_labels: Resolvable[bool] = Field(
        default_factory=lambda: Resolvable[bool](value=True),
        description="Automatically merge modelChoice labels with user labels",
    )


class FlowState(BaseModel):
    message_history: list[FlowModelMessage] = Field(default_factory=list)
    trace_items: list[TraceItem] = Field(default_factory=list)
    checkpoint_items: list[FlowCheckpointData] = Field(default_factory=list)
    user_actions: list[str] = Field(default_factory=list)
    run_usage: RunUsage = Field(default_factory=RunUsage)
    user_prompt_analysis: Optional[UserPromptAnalysis] = None
    artifacts: List[Union[dict, Any]] = Field(
        default_factory=list
    )  # Store artifact instances or dicts for backward compatibility
    chat_options: ChatOptionsState = Field(default_factory=ChatOptionsState, description="Chat input options state")

    # Debug control - None means no debugging
    breakpoint: Optional[FlowPhase] = None
    flow_phase: FlowPhase = FlowPhase.INITIAL
    debug_paused_at: Optional[FlowPhase] = None  # Phase where we paused (for resume)

    # Claude Code SDK session persistence
    claude_session_id: Optional[str] = None  # Session ID for resuming Claude Code conversations

    # AgenticProcessor state for MDO instruction execution
    processor_state: Optional[ProcessorState] = None

    @property
    def agent_message_history(self) -> List[ModelMessage]:
        return [m for m in self.message_history if isinstance(m, ModelRequest) or isinstance(m, ModelResponse)]

    @property
    def current_mode(self) -> FlowMode:
        if not self.chat_options:
            return FlowMode.UNKNOWN
        if not self.chat_options.mode:
            return FlowMode.UNKNOWN
        return self.chat_options.mode.resolved


class FlowStatePersistence(FullStatePersistence[FlowState, None]):
    async def load_next(self) -> NodeSnapshot[FlowState, None] | None:
        from flow_sdk.core.flow.nodes.route_human_input import RouteHumanInput

        # New flow
        if not self.history:
            await self.snapshot_node(FlowState(), RouteHumanInput())
            return cast(NodeSnapshot[FlowState, None], self.history[-1])
        snapshot = None
        # Original logic
        if snapshot := next((s for s in self.history if isinstance(s, NodeSnapshot) and s.status == "created"), None):
            snapshot.status = "pending"
            return snapshot

        # Recovery logic
        await self.snapshot_node(self.history[-1].state, RouteHumanInput())
        return cast(NodeSnapshot[FlowState, None], self.history[-1])

    def dump_json(self, *, indent: int | None = None) -> bytes:
        """Dump the history to JSON bytes. Overrides the default implementation to truncate the history."""
        assert self._snapshots_type_adapter is not None, "type adapter must be set to use `dump_json`"
        temp = self._snapshots_type_adapter.dump_json(
            self.history[-default_service_config.flow_state_persistence_node_snapshots_length :], indent=indent
        )
        return temp


# Note: No model_rebuild() needed since we're using Any instead of forward reference
