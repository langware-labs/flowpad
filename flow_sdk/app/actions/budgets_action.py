"""``budgets`` action — an organization's or team's pools and per-person allowances, hub-only.

``organization/<id>/budgets`` and ``team/<id>/budgets`` are answered by the hub's token
plan; there is no local copy of the money at all. The TS SDK (``budgets-service.ts``) sets
``ActionInfo.hub_reflect`` on every call, so the dispatcher in ``graph.py`` forwards it to
the hub (see ``_hub_reflect``).

Registered so ``budgets`` parses as an action instead of falling through to the entity's
own read (``APIRequest.from_api_path`` drops a segment that names no action) — that read
answered 200 with the ORGANIZATION, which the screen could not render.

The local body runs only when the call was NOT reflected (local-only entity, offline,
signed out), and fails loudly with 409 rather than fake-success.
"""

from __future__ import annotations

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.core.entity.entity_model import Entity

_OFFLINE_DETAIL = "Budgets require Flowpad Cloud; you're offline or signed out."


@action.get(action_name="budgets", types=["organization", "team"])
async def budgets(self: Entity):
    """The org's or team's pool and one row per person drawing on it — hub-only."""
    raise HTTPException(status_code=409, detail=_OFFLINE_DETAIL)
