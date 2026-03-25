"""Standalone agent configuration types (no Entity dependency)."""

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field

from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.core.flow.tools import SearchConfig
from .types.runtime_environment import ComputeNodeSize


class CheckpointMode(str, Enum):
    OFF = "off"
    APPROVE = "approve"
    AUTO = "auto"


class LLMConfig(BaseModel):
    model: Literal["anthropic/claude-sonnet-4.5", "openai/gpt-5"] | None = Field(default=None)


class AgentConfig(BaseModel):
    search: SearchConfig = Field(default_factory=SearchConfig)
    llm: LLMConfig = Field(default_factory=LLMConfig)
    checkpoint_mode: CheckpointMode = Field(default=CheckpointMode.AUTO)
    worker_type: WorkerType = Field(default=WorkerType.AUTO)
    planning_enabled: bool = Field(default=False)
    execution_enabled: bool = Field(default=True)
    machine_size: ComputeNodeSize = Field(default=ComputeNodeSize.SMALL)
