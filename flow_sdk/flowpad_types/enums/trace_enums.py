"""Trace enums - single source of truth for trace types."""

from enum import Enum


class TraceType(str, Enum):
    """All trace item types."""

    CHAT = "chat"
    PHASE_TRANSITION = "phase_transition"
    PROMPT_ANALYSIS = "prompt_analysis"
    TOOL_EXECUTION = "tool_execution"
    ERROR = "error"
    REASONING_STEP = "reasoning_step"
    PERFORMANCE_METRICS = "performance_metrics"


class TraceLevel(str, Enum):
    """Trace severity levels."""

    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
