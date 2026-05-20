"""Schema for one line in ``<output_folder>/workflow.analysis.jsonl``.

Mirrors the TypeScript `AnalysisRecord` shape used by the workflow-runner
UI (``ui/src/components/workflow-runner/data/types.ts``). Becomes the
canonical contract — analyzer skill builds should validate their output
against this model before writing.

We observed three different schemas emitted by the ``session_analysis``
skill across cycles 1-4 of the demo (``blocker/derived/info`` →
``error/warn/info`` → ``high/medium/low``). This schema + the shared
:mod:`flow_sdk.transcript_analyzer.severity` classifier eliminate the
drift at the source.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, ConfigDict


class AnchorRef(BaseModel):
    """Where this analysis record attaches to the workflow document."""

    model_config = ConfigDict(extra="ignore")
    file: str = Field(description="Absolute path to the workflow .md file.")
    line: int = Field(ge=1, description="1-indexed line number of the step bullet.")


class TraceSpan(BaseModel):
    """Timing envelope copied from the trace events that bracket this step."""

    model_config = ConfigDict(extra="ignore")
    enter_ts: Optional[datetime] = None
    done_ts: Optional[datetime] = None
    duration_ms: Optional[int] = Field(default=None, ge=0)
    status: Optional[str] = Field(
        default=None,
        description='"enter" / "done" / "error" / "skip" / "incomplete".',
    )
    detail: Optional[str] = None


class TranscriptToolCall(BaseModel):
    """One tool invocation inside a step's transcript span."""

    model_config = ConfigDict(extra="ignore")
    name: str
    result_summary: Optional[str] = None


class TranscriptSpan(BaseModel):
    """Pointer back into the agent's session jsonl for this step."""

    model_config = ConfigDict(extra="ignore")
    start_uuid: Optional[str] = None
    end_uuid: Optional[str] = None
    tool_calls: list[TranscriptToolCall] = Field(default_factory=list)


class AnalysisIssue(BaseModel):
    """One finding about this step.

    Fields are optional individually but at least one of ``kind``,
    ``category``, or ``severity`` should be set so the UI's tier classifier
    can place it. ``message`` (or legacy ``detail``) carries the
    human-readable description.
    """

    model_config = ConfigDict(extra="allow")
    kind: Optional[str] = Field(
        default=None,
        description=(
            "Canonical kind label (e.g. wrong_tool, retry, sla_violation). "
            "Used as a fallback when severity is absent."
        ),
    )
    category: Optional[str] = None
    severity: Optional[str] = Field(
        default=None,
        description="Free-form severity token (error/warn/info or high/medium/low).",
    )
    message: Optional[str] = None
    detail: Optional[str] = None
    threshold_ms: Optional[int] = None
    actual_ms: Optional[int] = None


class WorkflowAnalysisEntry(BaseModel):
    """One JSONL line in ``workflow.analysis.jsonl`` — one record per anchor."""

    model_config = ConfigDict(extra="allow")
    anchor: AnchorRef
    step_text: Optional[str] = Field(default=None, alias="step")
    trace: Optional[TraceSpan] = None
    transcript_span: Optional[TranscriptSpan] = None
    issues: list[AnalysisIssue] = Field(default_factory=list)
    recommendation: Optional[str] = None
    severity: Optional[str] = Field(
        default=None,
        description=(
            "Record-level severity hint, used when individual issues lack "
            "their own severity. Falls back to ``classify_severity`` of "
            "the most urgent issue when present."
        ),
    )
    extra: dict[str, Any] = Field(
        default_factory=dict,
        description="Bag for analyzer-specific metadata (run_history_ms, etc).",
    )
