"""AgenticFlow — a named boundary + policy over a flow subgraph.

Carries no wiring (edges live in the entity graph between FlowNodes and
Topics); it is purely an enable switch plus the loop-protection budget that
FlowManager charges correlation chains against. Membership: ``member_node_ids``
lists the FlowNodes inside the boundary.

DB-only entity (no ``asset_ref``).
"""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

# Router-level defaults applied when a chain's root is not inside any boundary.
DEFAULT_MAX_DEPTH = 8
DEFAULT_MAX_PROCESSES = 10
DEFAULT_DEADLINE_S = 600


class AgenticFlow(Entity):
    type: str = APIField(default=EntityType.AGENTIC_FLOW.value)
    name: str = APIField("")
    description: Optional[str] = APIField(None)
    enabled: bool = APIField(default=True)
    member_node_ids: list[str] = APIField(
        default_factory=list, description="FlowNode ids inside this boundary."
    )
    max_depth: int = APIField(default=DEFAULT_MAX_DEPTH)
    max_processes: int = APIField(
        default=DEFAULT_MAX_PROCESSES,
        description="Max AgenticProcess spawns charged to one correlation chain.",
    )
    deadline_s: int = APIField(
        default=DEFAULT_DEADLINE_S,
        description="Wall-clock budget for a correlation chain, seconds.",
    )

    _api_visible: ClassVar[bool] = True
