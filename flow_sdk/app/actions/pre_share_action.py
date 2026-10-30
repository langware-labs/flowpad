"""``GET <type>/<id>/pre_share`` — the generic pre-share handler.

Before the standard share dialog, a type may need something done first (a credential needs its
project's secret manager). The entity answers ``{needed: false}`` — the default, every type — or
``{needed: true, kind, title, detail, ...}``, and the dialog shows that type's step first. The
answer is the entity's own ``pre_share()``; nothing here knows a type.
"""
from __future__ import annotations

import logging

from flow_sdk.actions.action_registry import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


async def pre_share_of(entity_type: str, entity_id: str) -> dict:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(entity_type)
    entity = await cls.get_one({"id": entity_id}) if cls is not None else None
    hook = getattr(entity, "pre_share", None)
    if entity is None or hook is None:
        return {"needed": False}
    return await hook()


@action.get(action_name="pre_share", types="all")
async def pre_share_action() -> ApiResponse:
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found", status_code=400)
    typeid = request_info.target_entity_typeid
    try:
        return ApiSuccessResponse(data=await pre_share_of(typeid.type, str(typeid.id)))
    except Exception as e:  # noqa: BLE001 — a failed check never blocks a share
        logger.error("[pre-share] error for %s: %s", typeid, e, exc_info=True)
        return ApiSuccessResponse(data={"needed": False})
