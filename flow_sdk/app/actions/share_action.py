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
async def share_entity() -> ApiResponse:
    """Generic ``share`` — forward this entity to the hub.

    The URL identifies the authoritative local row. Git-publishable assets use
    their owning Project's path-scoped Git publication contract; every other
    entity preserves the legacy hub-share behavior.
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

    # Optional ``recipients`` (list of email strings): the entity's ``share``
    # implementation forwards each to ``POST /graph/<type>/<id>/members`` as a
    # standard ``MembershipRequest`` — see ``Conversation.share``.
    recipients = body.get("recipients")
    if recipients is not None and not isinstance(recipients, list):
        raise HTTPException(status_code=400, detail="share: 'recipients' must be a list")

    # Hub-only types have no local row to look up, and nothing to push: the entity already lives
    # on the hub and this endpoint's whole job for them is the invitation. Resolved BEFORE the
    # local fetch below, which would otherwise 404 every share of one. An ``LLMEndpoint`` is the
    # case that forced this — it is a read-only projection of hub state (see its module docstring).
    if entity_model._hub_only:
        if not recipients:
            raise HTTPException(
                status_code=400,
                detail=f"share: {target.type} exists only on the hub; pass 'recipients' to invite someone",
            )
        # A receipt, not the entity: a transient projection would serialize ~30 defaulted fields
        # as if they were this endpoint's real state.
        await entity_model(id=target.id).share(recipients=recipients)
        return ApiSuccessResponse(data={"id": target.id, "recipients": recipients})

    entity = await entity_model.get_one({"id": target.id})
    if entity is None:
        return ApiFailResponse(
            status_code=404,
            message="share: local entity not found",
            data={"code": "entity_not_found"},
        )

    project_git_origin = None
    if isinstance(entity, Project):
        # One owner for "what it takes to link a Project" — the Project Home
        # button and `flow record share --link-project` both come through here,
        # so they cannot enforce different preconditions.
        from flow_sdk.app.actions.project_publish import (  # noqa: PLC0415
            ProjectPublishBlocked,
            assert_project_publishable,
        )

        try:
            project_git_origin = await assert_project_publishable(entity, request_info.someone_typeid)
        except ProjectPublishBlocked as blocked:
            return ApiFailResponse(
                status_code=blocked.status_code, message=blocked.message, data=blocked.data()
            )
        # Carry the exact origin that passed the authoritative preflight into
        # the share operation and, below, into the durable local row.
        entity.origin = project_git_origin

    type_info = SchemaRegistry.get(target.type)
    if type_info is not None and type_info.git_publishable:
        if recipients:
            return ApiFailResponse(
                status_code=400,
                message="Invite members on the owning Project, not on an asset",
                data={
                    "code": "asset_recipients_not_allowed",
                },
            )
        if not request_info.someone_typeid:
            raise HTTPException(status_code=401, detail="share: authenticated user required")
        from flow_sdk.assets.git_publish import (  # noqa: PLC0415
            AssetPublishError,
            publish_git_asset,
        )

        try:
            result = await publish_git_asset(entity, request_info.someone_typeid)
        except AssetPublishError as exc:
            return ApiFailResponse(
                status_code=exc.status_code,
                message=exc.actionable,
                data={"code": str(exc.code), **exc.data},
            )
        return ApiSuccessResponse(data=result.model_dump(mode="json"))

    # Conversation and Project both implement a ``share(recipients=...)`` fan-out
    # (per-recipient MembershipRequest). Other types share without invites.
    try:
        if recipients and isinstance(entity, (Conversation, Project)):
            await entity.share(recipients=recipients)
        else:
            await entity.share()
    except Exception as exc:  # noqa: BLE001 — keep Project publish failures typed
        if isinstance(entity, Project):
            logger.warning("[share] publishing Project %s failed: %s", entity.id, exc)
            return ApiFailResponse(
                status_code=502,
                message="The Hub could not publish this Project",
                data={"code": "hub_publish_failed"},
            )
        raise

    # Send-side address-book reconcile (rule 4): learn every recipient — for ANY
    # shared entity type, not just conversations. A freshly-typed email carries no
    # user_id (expected); a conversation's existing roster carries user_id+email.
    # Non-fatal.
    if recipients:
        try:
            from flow_sdk.app.actions.flow_message_action import _learn_address_book  # noqa: PLC0415
            learn_entries: list[dict] = list(getattr(entity, "members", None) or [])
            learn_entries += [
                {"email": r} for r in recipients if isinstance(r, str) and r.strip()
            ]
            await _learn_address_book(learn_entries)
        except Exception as e:  # noqa: BLE001
            logger.warning("[share] address-book learning failed (non-fatal): %s", e)

    # A Project publication is not complete until all three canonical markers
    # survive a reload. Project.share() mutates them before returning, so this
    # save is deliberately unconditional (checking remote first was the bug:
    # remote was already true and the write was skipped).
    if isinstance(entity, Project):
        entity.origin = project_git_origin
        try:
            await entity.save(request_info.someone_typeid)
        except Exception:  # noqa: BLE001 — hub succeeded, local contract did not
            logger.exception("[share] persisting published Project %s failed", entity.id)
            return ApiFailResponse(
                status_code=500,
                message="Project was published, but its local publication state could not be saved",
                data={"code": "local_persist_failed"},
            )

    # Persist ``remote=True`` on other local rows so downstream consumers
    # (notably ``handle_add_message``'s ``is_remote_send`` gate) treat the
    # entity as hub-bound.
    elif "remote" in entity_model.model_fields:
        if getattr(entity, "remote", None) is not True:
            entity.remote = True
            try:
                await entity.save(request_info.someone_typeid)
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[share] persisting remote=True on local %s %s failed (non-fatal): %s",
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


# ── replying into the channel a conversation came from ───────────────────────


@action.post(action_name="send_external", types=["conversation"])
async def conversation_send_external() -> ApiResponse:
    """``POST /graph/conversation/<id>/send_external`` — reply into the cloud
    thread this conversation caches.

    Deliberately NOT a branch inside ``add_message``. That path is two hundred
    lines of hub semantics — cloud-login gates, remote-send forks, body uploads,
    delivery receipts — none of which apply to an email, and all of which would
    be at risk from a change made for one.

    Returns as soon as the send is DISPATCHED, not when it lands: an agent turn
    is tens of seconds and the conversation must stay usable. The reply appears
    by the ordinary ingest route once the worker records it, sorted into place
    by its own timestamp — there is no outbound rendering path.
    """
    from flow_sdk.inbox.outbound import dispatch_channel_reply  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400,
                            detail="send_external: target conversation typeid required")
    if request_info.target_entity_typeid.type != "conversation":
        raise HTTPException(status_code=400,
                            detail="send_external: target must be a conversation")

    body = await request_info.get_post_data() or {}
    text = str((body or {}).get("text") or (body or {}).get("message") or "").strip()
    if not text:
        return ApiFailResponse(message="send_external: an empty message is not a reply")

    return await dispatch_channel_reply(request_info.target_entity_typeid.id, text=text)
