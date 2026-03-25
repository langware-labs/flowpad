"""
Shared data types - used by traces, results, and other flow components.

Keep in sync with: flowpad/ui/sdk/src/types/trace.ts
"""

from typing import Optional

from pydantic import BaseModel


class TodoInfo(BaseModel):
    """Todo reference - embedded in traces and results."""

    id: str
    title: str
    status: str
    description: Optional[str] = None
    keywords: list[str] = []
    expected_artifacts: list[str] = []


class PhaseTransitionData(BaseModel):
    """Data for phase transition traces."""

    from_phase: str
    to_phase: str
    current_todo: Optional[TodoInfo] = None


class PromptAnalysisData(BaseModel):
    """Data for prompt analysis traces."""

    goal: str
    keywords: list[str] = []
    labels: list[str] = []
    expected_result_types: list[str] = []
    confidence: Optional[float] = None


class ToolExecutionData(BaseModel):
    """Data for tool execution traces."""

    tool_name: str
    tool_input: dict = {}
    tool_output: dict = {}
    duration_ms: Optional[int] = None
    success: bool = True


class ErrorData(BaseModel):
    """Data for error traces."""

    error_type: str
    error_message: str
    recoverable: bool = True
