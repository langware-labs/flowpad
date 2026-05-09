"""Schema for one line in <output_folder>/workflow.trace.jsonl.

The CLI ``flow workflow report --data '<json>'`` validates the agent's
payload against this model before appending. Single source of truth — the
analyzer (Phase 2) imports the same model.

V1 only emits ``kind="step"`` from the flow skill; the other kinds are
forward-compat — accepted by the schema but unused until later.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class WorkflowReportEntry(BaseModel):
    ts: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    kind: Literal["step", "condition", "call", "return"] = "step"
    file: str
    line: int
    status: Literal["enter", "done", "error", "skip", "true", "false"]
    detail: Optional[str] = None
    label: Optional[str] = None
    target: Optional[str] = None

    model_config = {"extra": "allow"}

    @model_validator(mode="after")
    def _check_kind_status(self) -> "WorkflowReportEntry":
        if self.kind == "step" and self.status not in {"enter", "done", "error", "skip"}:
            raise ValueError(
                f"kind=step requires status ∈ enter|done|error|skip, got {self.status!r}"
            )
        if self.kind == "condition":
            if self.status not in {"true", "false"}:
                raise ValueError("kind=condition requires status ∈ true|false")
            if not self.label:
                raise ValueError("kind=condition requires label")
        if self.kind in ("call", "return") and not self.target:
            raise ValueError(f"kind={self.kind} requires target")
        return self
