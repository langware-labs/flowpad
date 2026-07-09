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
from flow_sdk.builtin.project import Project
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

# Standardized copy for the privacy-mode block — kept in sync with the
# frontend guard (``ts_sdk/src/services/privacy-guard.ts``).
LOCAL_MODE_SHARE_MESSAGE = "Sharing disabled in Local mode"


def _local_mode_share_blocked() -> bool:
    """True when this instance is in Local privacy mode and must not share.

    The single backend gate the share/send/forward endpoints call before any
    hub side effect — belt-and-suspenders behind the frontend guard so the API
    can't be driven around the UI.
    """
    from flow_sdk.instance_settings.privacy_mode import is_local_mode  # noqa: PLC0415

    return is_local_mode()


@action.post(action_name="share", types="all")
async def share_entity() -> ApiSuccessResponse:
    """Generic ``share`` — forward this entity to the hub.

    Body is the client's entity dump; URL carries ``<type>/<id>``. We
    reconstruct the entity in-process (no DB save) and call ``.share()``
    which POSTs to the hub and flips ``remote=True``.
    """
    if _local_mode_share_blocked():
        raise HTTPException(status_code=403, detail=LOCAL_MODE_SHARE_MESSAGE)

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

    # Conversation and Project both implement a ``share(recipients=...)`` fan-out
    # (per-recipient MembershipRequest). Other types share without invites.
    if recipients and isinstance(entity, (Conversation, Project)):
        await entity.share(recipients=recipients)
    else:
        await entity.share()

    # Send-side address-book reconcile (rule 4): learn every recipient — for ANY
    # shared entity type, not just conversations. A freshly-typed email carries no
    # user_id (expected); a conversation's existing roster carries user_id+email.
    # Non-fatal.
    if recipients:
        try:
            from flow_sdk.app.actions.flow_message_action import _learn_address_book  # noqa: PLC0415
            learn_entries: list[dict] = list(getattr(entity, "participants", None) or [])
            learn_entries += [
                {"email": r} for r in recipients if isinstance(r, str) and r.strip()
            ]
            await _learn_address_book(learn_entries)
        except Exception as e:  # noqa: BLE001
            logger.warning("[share] address-book learning failed (non-fatal): %s", e)

    # Persist ``remote=True`` on the on-disk row so downstream consumers
    # (notably ``handle_add_message``'s ``is_remote_send`` gate) treat the
    # entity as hub-bound. ``entity`` above is a transient instance built
    # from the request body and not bound to a DB row, so we re-load by id
    # and save THAT.
    if "remote" in entity_model.model_fields:
        try:
            local_row = await entity_model.get_one({"id": target.id})
        except Exception as e:  # noqa: BLE001
            logger.warning("[share] local row lookup failed (non-fatal): %s", e)
            local_row = None
        if local_row is not None:
            changed = False
            if getattr(local_row, "remote", None) is not True:
                local_row.remote = True
                changed = True
            # Projects bind an opaque ``cloud_id`` at first share; the shared
            # instance built from the request body carries it back — persist it
            # on the local (path-id) row so re-shares/invites reuse the same
            # hub identity instead of minting a fresh one.
            ent_cloud = getattr(entity, "cloud_id", None)
            if ent_cloud and getattr(local_row, "cloud_id", None) != ent_cloud:
                local_row.cloud_id = ent_cloud
                changed = True
            if changed:
                try:
                    await local_row.save(request_info.someone_typeid)
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "[share] persisting remote/cloud_id on local %s %s failed (non-fatal): %s",
                        target.type, target.id, e,
                    )
    return ApiSuccessResponse(data=entity)


@action.post(action_name="add_message", types=["conversation"])
async def conversation_add_message() -> ApiResponse:
    """``POST /graph/conversation/<id>/add_message`` — the single endpoint for
    appending a message to a conversation.

    Text-only and attachment sends (files, images, prompt files, asset
    references) all come through here. The body is read multipart-aware and
    delegated to ``handle_add_message``, which builds the FlowMessage,
    persists it locally, appends the conversation.jsonl pointer, links it on
    the hub via ``add_message`` (so delivery receipts work), and uploads any
    attachment body in a background task.

    The conversation id is taken from the URL — it is the source of truth.
    """
    from flow_sdk.app.actions.notification_action import handle_add_message  # noqa: PLC0415
    from flow_sdk.cli.auth.hub_login import is_logged_in  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="add_message: target conversation typeid required")
    if request_info.target_entity_typeid.type != "conversation":
        raise HTTPException(status_code=400, detail="add_message: target must be a conversation")
    if not request_info.someone_typeid:
        return ApiFailResponse(message="No authenticated user in request context")

    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}

    # The URL is the source of truth for which conversation this lands in —
    # overwrite any stale id a caller might also have put in the body.
    body["conversation_id"] = request_info.target_entity_typeid.id

    # Drafts are local-only (no hub push) and stay allowed; only real sends
    # touch the cloud — those are blocked in Local mode. When cloud login is
    # unavailable we no longer refuse the send: the message is persisted locally
    # as ``pending_send`` (queued, not delivered) so nothing is lost, and a
    # later re-send (once logged in) flushes it. Local mode stays a hard block.
    pending_send = False
    if not bool(body.get("is_draft")):
        if _local_mode_share_blocked():
            return ApiFailResponse(message=LOCAL_MODE_SHARE_MESSAGE)
        if not is_logged_in():
            pending_send = True

    return await handle_add_message(
        body, request_info.someone_typeid, pending_send=pending_send,
    )


@action.post(action_name="forward", types=["flow_message"])
async def flow_message_forward() -> ApiResponse:
    """``POST /graph/flow_message/<id>/forward`` — clone a message into
    another conversation.

    Body: ``{conversation_id}`` (the target). The source message id comes
    from the URL. Delegates to ``handle_forward_message``, which clones the
    FlowMessage (new id, the caller as sender, fresh timestamps,
    ``cloned_from_id`` provenance, copied attachment bytes) and dispatches it
    into the target conversation through the same pipeline as a fresh send.
    """
    from flow_sdk.app.actions.notification_action import handle_forward_message  # noqa: PLC0415
    from flow_sdk.cli.auth.hub_login import is_logged_in  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="forward: target flow_message typeid required")
    if request_info.target_entity_typeid.type != "flow_message":
        raise HTTPException(status_code=400, detail="forward: target must be a flow_message")
    if not request_info.someone_typeid:
        return ApiFailResponse(message="No authenticated user in request context")

    try:
        body = await request_info.get_post_data() or {}
    except JSONDecodeError:
        body = {}

    # The URL is the source of truth for which message is being forwarded.
    body["flow_message_id"] = request_info.target_entity_typeid.id

    # Same gate as add_message — sends touch the cloud.
    if _local_mode_share_blocked():
        return ApiFailResponse(message=LOCAL_MODE_SHARE_MESSAGE)
    if not is_logged_in():
        return ApiFailResponse(message="Cloud login required to send messages")

    return await handle_forward_message(body, request_info.someone_typeid)
