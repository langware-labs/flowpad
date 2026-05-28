"""Generic ``members`` action — list participants of any entity.

Marked ``reflect="hub"`` so when the entity has a hub counterpart
(``remote=True``), the dispatcher in ``graph.py`` forwards the call to the
hub and mirrors the response onto the local row (see ``_hub_reflect.py``).

The local body runs only when the entity is local-only or the hub is
unreachable — it returns whatever participants the entity has cached.
Entities without a ``participants`` field return an empty list.
"""
from __future__ import annotations

from flow_sdk.actions import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse


@action.get(action_name="members", types="all", reflect="hub")
async def list_members(self: Entity) -> ApiSuccessResponse:
    participants = list(getattr(self, "participants", []) or [])
    return ApiResponse.success(data=participants)
