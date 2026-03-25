"""
Shared types package - data structures used across backend and frontend.

These types are the source of truth. Frontend TypeScript mirrors them manually.
"""

from flow_sdk.shared.data_types import (
    ErrorData,
    PhaseTransitionData,
    PromptAnalysisData,
    TodoInfo,
    ToolExecutionData,
)
from flow_sdk.shared.trace_item import TraceItem

__all__ = [
    # Data types
    "TodoInfo",
    "PhaseTransitionData",
    "PromptAnalysisData",
    "ToolExecutionData",
    "ErrorData",
    # Trace model
    "TraceItem",
]
