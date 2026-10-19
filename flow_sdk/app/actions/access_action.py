"""Generic ``access`` action — the hub's public-access stamps and child-access overrides.

``<type>/<id>/access/public/<visitor|authenticated>`` reads, sets or clears the role one
public audience holds on an entity; ``<type>/<id>/access/<parentType>/<parentId>`` does the
same for a child's override of what it inherits from a parent. Both are fully
hub-authoritative: the stamp is a column on the HUB row, and there is no local store for
it at all. The TS SDK (``entities/access.ts``) sets ``ActionInfo.hub_reflect`` on every
call, so the dispatcher in ``graph.py`` forwards it to the hub (see ``_hub_reflect``).

Registered so ``access/<sub_path>`` parses as an action instead of falling through to the
entity's own CRUD (``APIRequest.from_api_path`` drops a segment that names no action).

The local body runs only when the call was NOT reflected (local-only entity, offline,
signed out). Unlike ``members`` there is no cache to answer a GET from, so every verb
fails loudly with 409 rather than fake-success.
"""
from __future__ import annotations

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.core.entity.entity_model import Entity

_OFFLINE_DETAIL = "Access changes require Flowpad Cloud; you're offline or signed out."


@action.all(action_name="access", methods=["get", "put", "delete"], types="all")
async def access(self: Entity):
    """Read (``{audience, role}``), stamp (PUT ``{role}``) or clear an access grant — hub-only."""
    raise HTTPException(status_code=409, detail=_OFFLINE_DETAIL)
