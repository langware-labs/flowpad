"""
AgenticContext - Execution context for AgenticProcessor.

This is the ONLY context needed for clean direct execution - no bloated entities.
"""

from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from flow_sdk.builtin.compute_node import ComputeNode


class AgenticContext(BaseModel):
    """Execution context for AgenticProcessor.

    This is the ONLY context needed - no bloated entities.
    Provides clean interface for AgenticProcessor to execute using ClaudeSDKClient directly.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_name=True,
        arbitrary_types_allowed=True,
    )

    # Core dependencies
    compute_node: ComputeNode | None = None
    compute_node_id: str | None = None  # For serialization when compute_node not available

    # Execution settings
    instructions: str | None = None
    workdir: str | None = None
    env_vars: dict[str, str] = Field(default_factory=dict)

    # Worker settings
    model: str | None = None  # Optional: override default model
    max_thinking_tokens: int = 1024
    permission_mode: str = "bypassPermissions"

    # AMD (Agentic Markdown) support - when True, adds flow instruction system prompt and MCP
    amd_support: bool = False

    # Stack frame reference for data tools (read/write to ProcessorState.variables)
    stack_frame: dict[str, Any] | None = None

    # Tracing - when True, enables detailed state change reporting via FlowData
    tracing: bool = False

    # Session resume - when set, worker will attempt to resume this session
    resume_session_id: str | None = None

    # Fork session - when True with resume_session_id, creates a fork instead of resuming in-place
    fork_session: bool = False

    @model_validator(mode="after")
    def set_defaults(self) -> "AgenticContext":
        """Initialize defaults."""
        if self.workdir is None:
            self.workdir = str(Path.cwd())
        # Set compute_node_id from compute_node if available
        if self.compute_node is not None and self.compute_node_id is None:
            self.compute_node_id = self.compute_node.id
        return self

    def to_persistable_dict(self) -> dict[str, Any]:
        """Serialize context to a dict suitable for storing as process.context_data.

        This is the counterpart to AgenticProcess._restore_context() which
        reconstructs an AgenticContext from the persisted dict.
        """
        data = self.model_dump(exclude={"compute_node", "stack_frame"})
        # Ensure compute_node_id is always present
        if self.compute_node is not None:
            data["compute_node_id"] = self.compute_node.id
        return data
