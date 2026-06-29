"""AgentTrace entity — the analyzed timeline of one agentic execution.

Produced by the ``agent-trace`` skill (synthesizer skeleton + LLM annotations)
from a worker session transcript. The full trace JSON lives in the entity's
``asset_ref`` file (``.claude/agent_traces/<name>/trace.json``) — the entity
row carries only the small summary fields the UI needs to answer "what
happened, did it go well" instantly (verdict banner, counts, cost).

``trace`` is a create-time ferry (db-excluded): it carries the payload through
the create POST into ``default_body_fn`` (which materializes trace.json) and is
never persisted or returned on GET — viewers stream the file via FSRef instead.
"""

import json
from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, NoDBAPIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class AgentTrace(Entity):
    type: str = APIField(default=EntityType.AGENT_TRACE.value)
    name: str = APIField("")
    session_id: str = APIField("", description="Worker session id the trace was built from")
    worker_type: str = APIField("claude", description="Worker kind: claude | codex | copilot")
    analyzed_process_id: Optional[str] = APIField(
        None,
        description="AgenticProcess id whose worker session this trace analyzes",
    )
    verdict: Optional[str] = APIField(None, description="Overall outcome: ok | mixed | bad")
    verdict_reason: Optional[str] = APIField(None, description="One-line justification of the verdict")
    duration_ms: Optional[int] = APIField(None)
    cost_usd: Optional[float] = APIField(None)
    issue_count: int = APIField(0)
    divergence_count: int = APIField(0)
    lane_count: int = APIField(1, description="Root lane + subagent lanes")
    asset_ref: Optional[str] = APIField(None)
    # Create-time ferry only: JSON text consumed by default_body_fn (which
    # materializes trace.json at asset_ref). Never persisted to DB/blob —
    # viewers stream the file, GETs stay summary-sized.
    trace: Optional[str] = NoDBAPIField(default=None)

    @classmethod
    def from_trace(cls, trace: dict, *, name: str | None = None) -> "AgentTrace":
        """Build the entity from a trace JSON dict — the single authority for
        the trace→summary-fields mapping (used by the workers agent-trace
        route; anything else that materializes a record goes through here)."""
        summary = trace.get("summary") or {}
        return cls(
            name=name or trace.get("name") or f"trace-{(trace.get('session_id') or '')[:8]}",
            session_id=trace.get("session_id") or "",
            worker_type=trace.get("worker_type") or "claude",
            analyzed_process_id=trace.get("analyzed_process_id"),
            verdict=summary.get("verdict"),
            verdict_reason=summary.get("verdict_reason"),
            duration_ms=summary.get("duration_ms"),
            cost_usd=summary.get("cost_usd"),
            issue_count=summary.get("issue_count") or 0,
            divergence_count=summary.get("divergence_count") or 0,
            lane_count=summary.get("lane_count") or 1,
            trace=json.dumps(trace),
        )
