"""RunEvent — the envelope GraphWorkflowManager routes within ONE run.

NOT the bus envelope: the standard system-wide event is `FlowEvent`
(flow_sdk/tags/envelope.py). RunEvents are engine wiring — local names,
hop counters — and never ride the bus.

Events are local to their flow. ``execution_id`` is the run id — it stamps
every event, delivery, and spawned process of one activation, from trigger/
injection until the run sinks. Events are ephemeral: journaled into the run's
JSONL, never persisted as entities.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from flow_sdk.core.capabilities.models import now_iso
from flow_sdk.api.api_types.identifier import mint_uuid

# Virtual source node id for externally injected events (edges may route from it).
EXTERNAL_SOURCE = "$external"


class RunEvent(BaseModel):
    # Identity (provenance alignment, docs/flow-events.md phase 7): minted at
    # construction; PRESERVED from the bus envelope when a run is entered from
    # one (the relay law at the flow door — never re-minted).
    id: str = Field(default_factory=lambda: str(mint_uuid()))
    # Who caused it, target form — flows from the entry envelope's ctx.actor.
    actor: str | None = None
    event: str
    data: dict[str, Any] = Field(default_factory=dict)
    flow_id: str
    execution_id: str
    # Emitting node id, or EXTERNAL_SOURCE for injections without a source node.
    source_node: str = EXTERNAL_SOURCE
    hop: int = 0
    ts: str = Field(default_factory=now_iso)
