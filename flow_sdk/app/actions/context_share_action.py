"""HTTP endpoints for publishing / un-publishing shared context entries.

These are the canonical way for the frontend to mutate an entity's
``shared_context_entities`` list. The TS SDK has no method that writes to
the shared bucket directly (by design — sharing is a backend decision),
so the UI calls into here whenever it wants to bind a TypeId to an entity
in a way that propagates over the wire.

Wire shape:

  POST   /api/v1/graph/<type>/<id>/share-context
  POST   /api/v1/graph/<type>/<id>/unshare-context
  Body:  {"typeid": "<type>-<id>"}                     # single
         or
         {"typeids": ["<type>-<id>", "<type>-<id>"]}   # batch

Returns ``{"shared_context_entities": ["type-id", ...]}`` on success so the
caller can replace its local mirror in one round-trip without waiting for
the WS broadcast.
"""
from __future__ import annotations

import logging
from json import JSONDecodeError
from typing import Any

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


async def _resolve_target_entity() -> Entity:
    """Load the URL-targeted entity via the canonical request-context loader
    so the entity is bound to the active embedded-storage scope (required by
    the save path). Raises HTTPException if the typeid is missing, the type
    is unknown, or no row exists."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="context-share: target typeid required")
    target = request_info.target_entity_typeid
    if SchemaRegistry.get_entity_cls(target.type) is None:
        raise HTTPException(status_code=400, detail=f"context-share: unknown entity type {target.type}")
    entity = await request_info.get_target_entity()
    if entity is None:
        raise HTTPException(status_code=404, detail=f"context-share: {target} not found")
    return entity


def _parse_typeids(body: dict[str, Any]) -> list[TypeId]:
    """Extract one or many TypeIds from the request body. Accepts ``typeid``
    (single string or dict) or ``typeids`` (list of either). Raises an
    HTTPException on malformed input so the client gets a structured 400."""
    raw_items: list[Any] = []
    single = body.get("typeid")
    batch = body.get("typeids")
    if single is not None:
        raw_items.append(single)
    if isinstance(batch, list):
        raw_items.extend(batch)
    elif batch is not None:
        raise HTTPException(status_code=400, detail="context-share: 'typeids' must be a list")
    if not raw_items:
        raise HTTPException(
            status_code=400,
            detail="context-share: provide 'typeid' or 'typeids' in the body",
        )
    parsed: list[TypeId] = []
    for raw in raw_items:
        try:
            parsed.append(TypeId.to_typeid(raw))
        except (ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=400,
                detail=f"context-share: malformed typeid {raw!r}: {exc}",
            )
    return parsed


def _response_payload(entity: Entity) -> dict[str, Any]:
    return {
        "id": entity.id,
        "type": entity.get_type(),
        "shared_context_entities": [str(t) for t in entity.shared_context_entities],
        "shared_context_entity_data": dict(entity.shared_context_entity_data or {}),
    }


@action.post(action_name="share-context", types="all")
async def share_context() -> ApiResponse:
    """Append one or many TypeIds to the target entity's
    ``shared_context_entities`` and persist. Idempotent — already-present
    TypeIds are no-ops.

    Optional ``data`` (dict) in the body is forwarded as per-entry sidecar
    storage — applied to every typeid in the call. Used by file-backed
    chips to carry ``{path}`` so a 404 self-heal on click can single-file-
    index without a reverse-id lookup."""
    entity = await _resolve_target_entity()
    request_info = get_current_request_info()
    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}
    typeids = _parse_typeids(body)
    data = body.get("data")
    if data is not None and not isinstance(data, dict):
        raise HTTPException(
            status_code=400,
            detail="context-share: 'data' must be an object when provided",
        )
    changed = entity.add_shared_context_entities(*typeids, data=data)
    if changed:
        await entity.save(request_info.someone_typeid)
    return ApiSuccessResponse(data={"ok": changed, **_response_payload(entity)})


@action.post(action_name="unshare-context", types="all")
async def unshare_context() -> ApiResponse:
    """Remove one or many TypeIds from the target entity's
    ``shared_context_entities`` and persist. Idempotent — absent TypeIds
    are no-ops."""
    entity = await _resolve_target_entity()
    request_info = get_current_request_info()
    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}
    typeids = _parse_typeids(body)
    changed = entity.remove_shared_context_entities(*typeids)
    if changed:
        await entity.save(request_info.someone_typeid)
    return ApiSuccessResponse(data={"ok": changed, **_response_payload(entity)})
