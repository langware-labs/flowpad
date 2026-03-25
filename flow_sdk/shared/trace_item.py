"""
Generic TraceItem model - core trace structure.

Keep in sync with: flowpad/ui/sdk/src/types/trace.ts
"""

import uuid
from datetime import datetime
from typing import Generic, Optional, TypeVar

from pydantic import BaseModel, Field

from flow_sdk.flowpad_types.enums import TraceLevel, TraceType

T = TypeVar("T", bound=BaseModel)


class TraceItem(BaseModel, Generic[T]):
    """
    Generic trace item with typed data payload.

    Usage:
        trace = TraceItem[PhaseTransitionData](
            type=TraceType.PHASE_TRANSITION,
            message="Flow phase transitioned",
            data=PhaseTransitionData(from_phase="planning", to_phase="executing")
        )
    """

    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = Field(default_factory=datetime.now)
    type: TraceType
    level: TraceLevel = TraceLevel.INFO
    message: str
    summary: Optional[str] = None
    data: Optional[T] = None

    def compute_summary(self) -> str:
        """Compute summary from data if not already set."""
        if self.summary:
            return self.summary

        if self.data is None:
            return self.message[:100] if len(self.message) > 100 else self.message

        # Type-specific summary generation
        if self.type == TraceType.PHASE_TRANSITION and hasattr(self.data, "from_phase"):
            summary = f"{self.data.from_phase.upper()}->{self.data.to_phase.upper()}"
            if hasattr(self.data, "current_todo") and self.data.current_todo:
                title = self.data.current_todo.title
                summary += f" ({title[:30]}{'...' if len(title) > 30 else ''})"
            return summary

        if self.type == TraceType.PROMPT_ANALYSIS and hasattr(self.data, "goal"):
            goal = self.data.goal
            return f"Goal: {goal[:50]}{'...' if len(goal) > 50 else ''}"

        if self.type == TraceType.TOOL_EXECUTION and hasattr(self.data, "tool_name"):
            status = "✓" if self.data.success else "✗"
            return f"{status} {self.data.tool_name}"

        if self.type == TraceType.ERROR and hasattr(self.data, "error_type"):
            msg = self.data.error_message
            return f"[{self.data.error_type}] {msg[:50]}{'...' if len(msg) > 50 else ''}"

        return self.message[:100] if len(self.message) > 100 else self.message
