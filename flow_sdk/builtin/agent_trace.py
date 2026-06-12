"""AgentTrace entity — the analyzed timeline of one agentic execution.

Produced by the ``agent-trace`` skill (synthesizer skeleton + LLM annotations)
from a worker session transcript. The full trace JSON lives in the entity's
``asset_ref`` file (``.claude/agent_traces/<name>/trace.json``) — the entity
row carries only the small summary fields the UI needs to answer "what
happened, did it go well" instantly (verdict banner, counts, cost).

``trace`` is a blob field: it ferries the payload through the create POST into
``default_body_fn`` (which materializes trace.json) and is never expanded on
GET — viewers stream the file via FSRef instead.
"""

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class AgentTrace(Entity):
    type: str = APIField(default=EntityType.AGENT_TRACE.value)
    name: str = APIField("")
    session_id: str = APIField("", description="Worker session id the trace was built from")
    worker_type: str = APIField("claude", description="Worker kind: claude | codex | copilot")
    verdict: Optional[str] = APIField(None, description="Overall outcome: ok | mixed | bad")
    verdict_reason: Optional[str] = APIField(None, description="One-line justification of the verdict")
    duration_ms: Optional[int] = APIField(None)
    cost_usd: Optional[float] = APIField(None)
    issue_count: int = APIField(0)
    divergence_count: int = APIField(0)
    lane_count: int = APIField(1, description="Root lane + subagent lanes")
    asset_ref: Optional[str] = APIField(None)
    # JSON text (blob storage is string-only); default_body_fn parses it.
    trace: Optional[str] = APIField(None, blob=True)
