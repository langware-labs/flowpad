"""Local HTTP wrappers that forward share()/add_message() to the hub.

These exist so the TS SDK can call standard graph actions —
``POST /api/v1/graph/<type>/<id>/share`` and
``POST /api/v1/graph/conversation/<id>/add_message`` — instead of holding
hub-client state. The handlers just instantiate the Python entity (no local
save) and delegate to its ``share()`` / ``add_message()`` methods, which talk
to the hub through ``FlowpadClient`` using the stored cloud credentials.
"""
from __future__ import annotations

import logging
from json import JSONDecodeError

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiSuccessResponse

logger = logging.getLogger(__name__)


@action.post(action_name="share", types="all")
async def share_entity() -> ApiSuccessResponse:
    """Generic ``share`` — forward this entity to the hub.

    Body is the client's entity dump; URL carries ``<type>/<id>``. We
    reconstruct the entity in-process (no DB save) and call ``.share()``
    which POSTs to the hub and flips ``remote=True``.
    """
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="share: target typeid required")
    target = request_info.target_entity_typeid

    entity_model: type[Entity] | None = SchemaRegistry.get_entity_cls(target.type)
    if not entity_model:
        raise HTTPException(status_code=400, detail=f"share: unknown entity type {target.type}")

    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}

    sanitized = {k: v for k, v in body.items() if entity_model.is_api_field(k)}
    sanitized["id"] = target.id
    entity = entity_model.model_validate(sanitized)

    await entity.share()
    return ApiSuccessResponse(data=entity)


@action.post(action_name="add_message", types=["conversation"])
async def conversation_add_message() -> ApiSuccessResponse:
    """``POST /graph/conversation/<id>/add_message`` — forward to hub.

    Body: ``{"text": str, "sender_name": str?}``. Returns the hub's response
    payload (the persisted FlowMessage as serialized by the hub).
    """
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="add_message: target conversation typeid required")
    if request_info.target_entity_typeid.type != "conversation":
        raise HTTPException(status_code=400, detail="add_message: target must be a conversation")

    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}

    text = body.get("text")
    if not isinstance(text, str) or not text:
        raise HTTPException(status_code=400, detail="add_message: 'text' is required")

    conv = Conversation(id=request_info.target_entity_typeid.id)
    data = await conv.add_message(text, sender_name=body.get("sender_name"))
    return ApiSuccessResponse(data=data)
