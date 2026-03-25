"""Flow execution state management."""

import json
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Optional

from pydantic import BaseModel, Field


class FlowPhase(StrEnum):
    """Execution phases in a flow."""

    INITIAL = "initial"
    PLANNING = "planning"
    EXECUTING = "executing"
    REPORTING = "reporting"
    COMPLETED = "completed"
    ERROR = "error"


class FlowMode(StrEnum):
    """Execution modes for flows."""

    ASK = "ask"  # Simple Q&A mode
    AGENT = "agent"  # Full agentic mode with planning
    AUTO = "auto"  # Automatic mode selection


class RunUsage(BaseModel):
    """Token and API usage tracking."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0

    def add(self, other: "RunUsage") -> None:
        """Add another usage to this one."""
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_read_tokens += other.cache_read_tokens
        self.cache_creation_tokens += other.cache_creation_tokens


class ChatMessage(BaseModel):
    """A single message in the conversation."""

    role: str  # "user" or "assistant"
    content: str
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class FlowState(BaseModel):
    """Central state container for flow execution."""

    model_config = {"arbitrary_types_allowed": True}

    # Conversation history
    message_history: list[ChatMessage] = Field(default_factory=list)

    # Current execution state
    flow_phase: FlowPhase = FlowPhase.INITIAL
    flow_mode: FlowMode = FlowMode.AUTO

    # Generated artifacts and results
    artifacts: list[dict[str, Any]] = Field(default_factory=list)

    # API usage tracking
    run_usage: RunUsage = Field(default_factory=RunUsage)

    # Debug state
    debug_paused_at: Optional[FlowPhase] = None
    breakpoint: Optional[FlowPhase] = None

    # Session persistence (for Claude Code SDK)
    claude_session_id: Optional[str] = None

    # Additional context
    metadata: dict[str, Any] = Field(default_factory=dict)

    def to_json(self) -> str:
        """Serialize state to JSON string."""
        return self.model_dump_json()

    @classmethod
    def from_json(cls, json_str: str) -> "FlowState":
        """Deserialize state from JSON string."""
        return cls.model_validate_json(json_str)

    def add_message(self, role: str, content: str) -> None:
        """Add a message to history."""
        self.message_history.append(ChatMessage(role=role, content=content))

    def add_artifact(self, artifact_data: dict[str, Any]) -> None:
        """Add an artifact to the artifacts list."""
        if "created_at" not in artifact_data:
            artifact_data["created_at"] = datetime.now(timezone.utc).isoformat()
        self.artifacts.append(artifact_data)

    def set_phase(self, phase: FlowPhase) -> None:
        """Set the current execution phase."""
        self.flow_phase = phase

    def set_mode(self, mode: FlowMode) -> None:
        """Set the execution mode."""
        self.flow_mode = mode

    def add_usage(self, usage: RunUsage) -> None:
        """Add usage metrics to running total."""
        self.run_usage.add(usage)
