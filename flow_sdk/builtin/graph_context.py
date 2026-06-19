"""GraphContext entity — a frozen snapshot of the global context.

An *automation* is an agentic process run with a *prompt* + a *context*, where
the context is a list of typeids. ``GraphContext`` is the saved ("frozen") half
of that pair: when the user clicks "Open Context" the frontend copies the
current ``DataContext`` slots (project / flow / process / compute node / …) into
a new ``GraphContext`` and opens it in a tab.

Like ``Tab`` and ``File`` this type is DB-only: no asset_ref, no FSRecord, never
walked. The full entity JSON (including ``context_typeids`` / ``slot_map``)
persists in the SQLite row; generic CRUD is served by the graph actions, so no
type-specific action code is needed.
"""

from __future__ import annotations

from typing import Dict, List

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class GraphContext(Entity):
    type: str = APIField(default=EntityType.GRAPH_CONTEXT.value)

    # Flat list of frozen typeid strings ("<type>-<id>") captured at snapshot time.
    context_typeids: List[str] = APIField(default_factory=list)

    # Optional map of context-slot name (ContextEntitiesEnum value, e.g.
    # "CurrentProjectTypeId") → typeid string, so the viewer can group/label
    # each frozen typeid by which slot it came from. The flat list above stays
    # the source of truth for "what is in this context".
    slot_map: Dict[str, str] = APIField(default_factory=dict)
