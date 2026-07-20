"""FlowEvent — the envelope FlowManager routes within ONE flow.

Events are local to their flow. ``execution_id`` is the run id — it stamps
every event, delivery, and spawned process of one activation, from trigger/
injection until the run sinks. Events are ephemeral: journaled into the run's
JSONL, never persisted as entities.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from flow_sdk.core.capabilities.models import now_iso

# Virtual source node id for externally injected events (edges may route from it).
EXTERNAL_SOURCE = "$external"


class FlowEvent(BaseModel):
    event: str
    data: dict[str, Any] = Field(default_factory=dict)
    flow_id: str
    execution_id: str
    # Emitting node id, or EXTERNAL_SOURCE for injections without a source node.
    source_node: str = EXTERNAL_SOURCE
    hop: int = 0
    ts: str = Field(default_factory=now_iso)
