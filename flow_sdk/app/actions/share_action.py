"""Local HTTP wrappers that forward share()/add_message() to the hub.

These exist so the TS SDK can call standard graph actions —
``POST /api/v1/graph/<type>/<id>/share`` and
``POST /api/v1/graph/conversation/<id>/add_message`` — instead of holding
hub-client state. The handlers just instantiate the Python entity (no local
save) and delegate to its ``share()`` / ``add_message()`` methods, which talk
to the hub through ``FlowpadClient`` using the stored cloud credentials.
"""
from __future__ import annotations

import asyncio
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

    # Optional ``recipients`` (list of email strings): the entity's ``share``
    # implementation forwards each to ``POST /graph/<type>/<id>/members`` as a
    # standard ``MembershipRequest`` — see ``Conversation.share``.
    recipients = body.get("recipients")
    if recipients is not None and not isinstance(recipients, list):
        raise HTTPException(status_code=400, detail="share: 'recipients' must be a list")

    if recipients and isinstance(entity, Conversation):
        await entity.share(recipients=recipients)
        try:
            from flow_sdk.app.actions.flow_message_action import _learn_address_book  # noqa: PLC0415
            learn_entries: list[dict] = list(entity.participants or [])
            learn_entries += [
                {"email": r} for r in recipients if isinstance(r, str) and r.strip()
            ]
            await _learn_address_book(learn_entries)
        except Exception as e:  # noqa: BLE001
            logger.warning("[share] address-book learning failed (non-fatal): %s", e)
    else:
        await entity.share()
    return ApiSuccessResponse(data=entity)


@action.post(action_name="add_message", types=["conversation"])
async def conversation_add_message() -> ApiSuccessResponse:
    """``POST /graph/conversation/<id>/add_message`` — forward to hub.

    Body: ``{"text": str, "sender_name": str?}``. Returns the hub's response
    payload (the persisted FlowMessage as serialized by the hub).

    After the hub stores the message, mirror it into the local DB via
    ``materialize_flow_message`` — the hub WS bridge intentionally skips the
    sender's own auto-notify CREATE frame (see ``hub_bridge._handle_flow_message_op``),
    so without this write the sender's local ``Conversation.message_ids`` stays
    empty until a manual refresh. The ``append-conversation`` path used for
    follow-up replies materializes for the same reason.
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

    attachments = body.get("attachment")
    if attachments is not None and not isinstance(attachments, list):
        raise HTTPException(status_code=400, detail="add_message: 'attachment' must be a list")
    context_entities = body.get("context_entities")
    if context_entities is not None and not isinstance(context_entities, list):
        raise HTTPException(status_code=400, detail="add_message: 'context_entities' must be a list")

    conv_id = request_info.target_entity_typeid.id
    conv = Conversation(id=conv_id)
    data = await conv.add_message(
        text,
        sender_name=body.get("sender_name"),
        attachments=attachments,
        context_entities=context_entities,
    )

    # Mirror the hub-confirmed FM into the sender's local DB. ConversationView
    # renders strictly from the conversation's ``message_ids`` projection —
    # only a local DB write populates it. Caching the response entity alone
    # adds no pointer, so the sender would never see her own message, and a
    # refresh can't recover it: the hub ``_fanout_message`` skips the sender,
    # so her WS bridge never materializes it either.
    #
    # Run detached so the HTTP response isn't blocked on the ~300-800ms write
    # — same fire-and-forget pattern the inbound bridge uses
    # (``hub_bridge._persist_inbound``). ``notify=True`` makes the open
    # conversation refetch the moment the pointer lands.
    someone_typeid = request_info.someone_typeid
    if isinstance(data, dict) and data.get("id"):
        async def _materialize_sender_copy() -> None:
            try:
                from flow_sdk.app.actions.materialize_flow_message import (  # noqa: PLC0415
                    materialize_flow_message,
                )
                await materialize_flow_message(
                    data,
                    conversation_id=conv_id,
                    someone_typeid=someone_typeid,
                    notify=True,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("[add_message] sender-side materialize failed: %s", e, exc_info=True)

        asyncio.create_task(_materialize_sender_copy())

    return ApiSuccessResponse(data=data)
