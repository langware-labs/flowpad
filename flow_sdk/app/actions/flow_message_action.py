"""HTTP actions for FlowMessage file transport.

  POST /api/v1/graph/flow-message-upload      — upload .flowmsg (multipart, global action)
  GET  /api/v1/graph/flow_message/{id}/create-and-download-local-flowmsg  — download .flowmsg (entity-scoped)
  GET  /api/v1/graph/flow_message/{id}/open   — deep-link: fetch from hub and open IncomingTaskDialog
"""
import asyncio
import json as _json
import logging
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from flow_sdk._compat import UTC
from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import AttachmentType, BodyStatus, DeliveryStatus, FlowMessage, FlowMessageKind
from flow_sdk.builtin.flow_message_bundle import FlowMessageExistsError
from flow_sdk.core.entity.entity_model import remote_reflection
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.organization import Organization
from flow_sdk.builtin.team import Team
from flow_sdk.builtin.user import User
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.operations.conversation import (
    append_message_pointer,
    default_jsonl_path,
    from_jsonl,
    message_pointers,
    project_pointers_to_entity,
    prune_message_pointer,
    write_pointers,
)
from flow_sdk.fs_store.pointer import Pointer
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.hub import hub_base_url, hub_get, hub_post

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from flow_sdk.builtin.invitation import Invitation


def _meaningful_name(title: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return name[:60] or "untitled"


def _participant_value(participant: dict, *keys: str) -> Optional[str]:
    if not isinstance(participant, dict):
        return None
    for key in keys:
        value = participant.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _normalize_participants(participants: list[dict]) -> list[dict]:
    normalized: list[dict] = []
    for participant in participants or []:
        if not isinstance(participant, dict):
            continue
        item = dict(participant)
        email = _participant_value(participant, "email", "user_email")
        name = _participant_value(participant, "name", "user_name")
        picture = _participant_value(participant, "picture", "user_picture")
        if email and not item.get("email"):
            item["email"] = email
        if name and not item.get("name"):
            item["name"] = name
        if picture and not item.get("picture"):
            item["picture"] = picture
        normalized.append(item)
    return normalized


def _participant_label(participant: dict) -> str:
    if not isinstance(participant, dict):
        return "unknown"
    return (
        _participant_value(participant, "name", "user_name")
        or _participant_value(participant, "email", "user_email")
        or "unknown"
    )


async def _learn_address_book(participants: list[dict]) -> None:
    for participant in _normalize_participants(participants):
        email = _participant_value(participant, "email")
        if not email:
            continue
        name = _participant_value(participant, "name")
        await User.get_or_create_by_email(email, name=name)


async def handle_upload_flow_message(file, overwrite: bool) -> ApiResponse:
    """Accept a .flowmsg zip upload and materialize entities."""
    local_user = await User.get_one({"uname": "local"})
    local_user_id = local_user.id if local_user else ""

    with tempfile.NamedTemporaryFile(suffix=".flowmsg", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        content = await file.read()
        tmp.write(content)

    try:
        fm = await FlowMessage.from_file(tmp_path, local_user_id, overwrite=overwrite)
    except FlowMessageExistsError as exc:
        return ApiFailResponse(
            message="FlowMessage already exists",
            status_code=409,
            data={"conflicts": exc.conflicts},
        )
    finally:
        tmp_path.unlink(missing_ok=True)

    task_id = next((c.id for c in fm.shared_context_entities if c.type == BuiltinEntityType.TASK.value), None)
    conv_id = next((c.id for c in fm.shared_context_entities if c.type == BuiltinEntityType.CONVERSATION.value), None)

    return ApiSuccessResponse(data={
        "message_id": fm.id,
        "task_id": task_id,
        "conversation_id": conv_id,
        "was_new_task": True,
    })


async def handle_download_flow_message(fm_id: str) -> ApiResponse:
    """Stream a .flowmsg zip for a FlowMessage entity."""
    from fastapi.responses import FileResponse
    from starlette.background import BackgroundTask

    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)

    zip_path = await fm.to_file()
    sender = re.sub(r"[^a-z0-9]+", "-", (fm.sender_name or "unknown").lower()).strip("-")[:30]
    dt = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    filename = f"{sender}-{dt}.flowmsg"

    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(lambda: os.unlink(zip_path) if zip_path.exists() else None),
    )


@action.post(action_name="flow-message-upload", types=None)
async def upload_flow_message() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        post_data = await request_info.get_post_data() or {}
        upload_file = post_data.get("file")
        if not upload_file or not hasattr(upload_file, "read"):
            return ApiFailResponse(message="No file uploaded", status_code=400)

        overwrite_qp = request_info.request.query_params.get("overwrite", "false")
        overwrite_form = str(post_data.get("overwrite", "false")).lower()
        overwrite = overwrite_qp.lower() in ("true", "1", "yes") or overwrite_form in ("true", "1", "yes")
        return await handle_upload_flow_message(upload_file, overwrite)
    except Exception as e:
        logger.error(f"[flow_message_action] upload error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Upload failed: {str(e)}")


async def handle_open_flow_message(fm_id: str) -> ApiResponse:
    """Fetch FlowMessage from hub, materialise bundle if needed, delegate to deep-link handler."""
    from flow_sdk.builtin.flow_message import AttachmentType
    from flow_sdk.server.routes.notify import handle_notification_deep_link

    data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
    meta = (data or {}).get("metadata") or {}

    # The first REPO attachment URL triggers the git pull/clone flow; absence means bundle path.
    raw_attachments = (data or {}).get("attachment") or []
    repo_url = next(
        (a["data"] for a in raw_attachments
         if isinstance(a, dict) and a.get("attachment_type") == AttachmentType.REPO.value and a.get("data")),
        "",
    )

    attachment_filename = ((data or {}).get("attachment_filename") or "").strip()

    # Always download/unpack the specific message's bundle when one exists.
    # The bundle materializes the local FlowMessage (and its Conversation /
    # optional Task), so the UI deep link can navigate directly without
    # needing a separate FM lookup. Scenario B has no Task — only the bundle
    # gates the download.
    if not repo_url and attachment_filename:
        try:
            await _download_and_unpack_bundle(
                fm_id, attachment_filename, body_status=(data or {}).get("body_status"),
            )
        except Exception as e:
            logger.warning("[open_flow_message] failed to materialize bundle (non-fatal): %s", e)

    # Resolve conversation_id / task_id. Try the local FM first (populated by
    # ``_download_and_unpack_bundle`` above). When there's no bundle — e.g. a
    # text-only first message from ``NewConversationDialog`` — the local FM
    # never materializes; we additionally walk the conv's hub-side parent
    # relationship so the deep link still carries conv_id and we can sync
    # the conv content directly from the hub below.
    conversation_id = ""
    task_id = ""
    local_fm = await FlowMessage.get_one({"id": fm_id})
    if local_fm:
        conversation_id = getattr(local_fm, "conversation_id", "") or ""
        for ctx in (local_fm.shared_context_entities or []):
            if getattr(ctx, "type", None) == BuiltinEntityType.TASK.value and not task_id:
                task_id = getattr(ctx, "id", "") or ""
    else:
        # Fall back to the hub's context list (string typeids like
        # "conversation-<uuid>"). Format kept loose to tolerate variations.
        # Accept both the new ``shared_context_entities`` key and the legacy
        # ``context_entities`` key in case the hub hasn't fully cut over.
        hub_ctx = (
            (data or {}).get("shared_context_entities")
            or (data or {}).get("context_entities")
            or []
        )
        for raw in hub_ctx:
            s = raw if isinstance(raw, str) else str(raw)
            if s.startswith(f"{BuiltinEntityType.CONVERSATION.value}-") and not conversation_id:
                conversation_id = s.split("-", 1)[1]
            elif s.startswith(f"{BuiltinEntityType.TASK.value}-") and not task_id:
                task_id = s.split("-", 1)[1]
        if not task_id:
            task_id = (meta.get("task_id") or (data or {}).get("task_id") or "").strip()

    # When the conv is known but not yet on the recipient's local DB, sync it
    # directly from the hub (the bundle-unpack path normally does this, but
    # text-only first messages ship without a bundle).
    if conversation_id:
        try:
            request_info = get_current_request_info()
            someone_typeid = request_info.someone_typeid if request_info else None
            if someone_typeid:
                await _ensure_local_conversation_synced(conversation_id, someone_typeid)
        except Exception as e:
            logger.warning("[open_flow_message] conv sync failed (non-fatal): %s", e, exc_info=True)

    logger.warning(
        "[open_flow_message] fm_id=%s attachment_filename=%r repo_url=%r conv_id=%s task_id=%s",
        fm_id, attachment_filename, repo_url, conversation_id, task_id,
    )

    return await handle_notification_deep_link(
        fm_id=fm_id,
        conversation_id=conversation_id,
        task_id=task_id,
        project_url=repo_url,
        branch=(meta.get("branch") or (data or {}).get("branch") or "").strip(),
        repo_id=(meta.get("repo_id") or (data or {}).get("repo_id") or "").strip(),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        title=(meta.get("task_title") or meta.get("spec_title") or (data or {}).get("task_title") or "").strip(),
    )


@action.get(action_name="open", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def open_flow_message() -> ApiResponse:
    """Deep-link handler: fetch FlowMessage from hub and redirect to IncomingTaskDialog."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_open_flow_message(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error("[flow_message_action] open error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Open failed: {str(e)}")


@action.get(action_name="create-and-download-local-flowmsg", types=["flow_message"])
async def download_flow_message() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")

        return await handle_download_flow_message(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error(f"[flow_message_action] download error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Download failed: {str(e)}")


# ---------------------------------------------------------------------------
# Header / Body interface (principle #6 — exposes FlowMessage body methods
# over HTTP so the UI + vitest tests can drive the same contract).
# ---------------------------------------------------------------------------


async def _load_fm_local_or_hub(fm_id: str) -> Optional[FlowMessage]:
    """Get the FM from the local DB; on miss, fall back to the hub.

    Sender-side, the local DB lags the hub (Conversation.add_message goes
    straight to the hub and the bridge fanout skips the sender), so a freshly-
    created FM exists on the hub before it lands locally. The fallback keeps
    body actions usable in that window.
    """
    fm = await FlowMessage.get_one({"id": fm_id})
    if fm is not None:
        return fm
    from flow_sdk.utils.hub import hub_get
    payload = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
    if not payload:
        return None
    return FlowMessage.model_validate(payload)


async def handle_has_body(fm_id: str) -> ApiResponse:
    """Return whether the FM has body-requiring attachments."""
    fm = await _load_fm_local_or_hub(fm_id)
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    return ApiSuccessResponse(data={"has_body": fm.has_body()})


async def handle_upload_body(fm_id: str) -> ApiResponse:
    """Pack + upload this message's body bundle. Idempotent: a second call
    re-uploads (the hub PUT overwrites). On failure the hub-side body_status
    remains UPLOADING and the exception surfaces as an ApiFailResponse."""
    fm = await _load_fm_local_or_hub(fm_id)
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    from flow_sdk.core.network.resource_tracker import make_flow_message_progress_emitter
    try:
        await fm.upload_body(on_progress=make_flow_message_progress_emitter(fm_id, "upload"))
    except Exception as e:
        logger.error("[flow_message_action] upload_body fm=%s: %s", fm_id, e, exc_info=True)
        return ApiFailResponse(message=f"upload_body failed: {e}")
    return ApiSuccessResponse(data={
        "flow_message_id": fm.id,
        "body_status": fm.body_status.value if hasattr(fm.body_status, "value") else fm.body_status,
        "attachment_filename": fm.attachment_filename,
    })


async def handle_download_body(fm_id: str, *, overwrite: bool = False) -> ApiResponse:
    """Download + unpack this message's body bundle. Refuses (BodyNotReadyError)
    if body_status != READY — receivers must wait for the hub UPDATE fanout.

    ``overwrite`` — replace an existing on-disk asset on a genuine collision. On
    a conflict with ``overwrite=False`` this returns a 409 carrying
    ``asset_conflict`` + the conflicting paths so the UI can prompt the user and
    re-POST with ``overwrite=True``."""
    from flow_sdk.builtin.flow_message import BodyNotReadyError
    from flow_sdk.builtin.flow_message_bundle import (
        FlowMessageExistsError, FlowMessageNoProjectError,
    )
    from flow_sdk.core.network.resource_tracker import make_flow_message_progress_emitter
    fm = await _load_fm_local_or_hub(fm_id)
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    # File-backed assets unpack into the conversation's mapped PROJECT (the
    # destination is resolved inside unpack_bundle from the conversation). No
    # asset_dest_root to pass — the project is the single source of placement.
    try:
        await fm.download_body(
            overwrite=overwrite,
            on_progress=make_flow_message_progress_emitter(fm_id, "download"),
        )
    except BodyNotReadyError as e:
        return ApiFailResponse(message=str(e), status_code=409)
    except FlowMessageExistsError as e:
        # Actionable conflict: surface the paths so the UI can ask "asset
        # already exists — overwrite?" and re-POST with overwrite=True.
        return ApiFailResponse(
            message="asset already exists — overwrite?",
            status_code=409,
            data={"asset_conflict": True, "conflicts": getattr(e, "conflicts", None)},
        )
    except FlowMessageNoProjectError as e:
        # The conversation isn't mapped to a project — nowhere to land the
        # assets. Tell the UI to prompt project selection then re-download.
        return ApiFailResponse(
            message="map a project to this conversation first",
            status_code=409,
            data={"needs_project": True, "pending_types": getattr(e, "pending_types", None)},
        )
    except Exception as e:
        logger.error("[flow_message_action] download_body fm=%s: %s", fm_id, e, exc_info=True)
        return ApiFailResponse(message=f"download_body failed: {e}")
    return ApiSuccessResponse(data={
        "flow_message_id": fm.id,
        "body_status": fm.body_status.value if hasattr(fm.body_status, "value") else fm.body_status,
    })


@action.get(action_name="has_body", types=["flow_message"])
async def has_body_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_has_body(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error(f"[flow_message_action] has_body error: {e}", exc_info=True)
        return ApiFailResponse(message=f"has_body failed: {e}")


@action.post(action_name="upload_body", types=["flow_message"])
async def upload_body_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_upload_body(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error(f"[flow_message_action] upload_body error: {e}", exc_info=True)
        return ApiFailResponse(message=f"upload_body failed: {e}")


@action.post(action_name="download_body", types=["flow_message"])
async def download_body_action() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        body = await request_info.get_post_data() or {}
        overwrite = bool(body.get("overwrite", False))
        return await handle_download_body(
            str(request_info.target_entity_typeid.id), overwrite=overwrite,
        )
    except Exception as e:
        logger.error(f"[flow_message_action] download_body error: {e}", exc_info=True)
        return ApiFailResponse(message=f"download_body failed: {e}")


# ---------------------------------------------------------------------------
# Project-scoped conversation creation (no Task)
# ---------------------------------------------------------------------------


async def handle_create_project_conversation(
    project_id: str,
    participants: list[dict],
    someone_typeid: str,
    title: Optional[str] = None,
    shared_context_entities: Optional[list] = None,
) -> ApiResponse:
    """Create a Conversation directly under a Project (no Task).

    Each participant entry is {email, name?}. Every email is upserted as a
    local User so the contact list grows automatically. `title` becomes the
    conversation's display name; when omitted, falls back to a participants
    summary.

    The owning project is DERIVED from the shared/target entity, not the
    client's ambient active project: when ``shared_context_entities`` carry an
    entity with a project, that project wins — ``project_id`` (the request's
    ambient default) is only the fallback. This keeps the assignment
    deterministic and computed once at create (see ``Conversation.resolve_project_id``).
    """
    from flow_sdk.builtin.project import Project

    effective_project_id = await Conversation.resolve_project_id(
        shared_context_entities, fallback=project_id
    )
    if not effective_project_id:
        return ApiFailResponse(message="project_id is required")

    project = await Project.get_one({"id": effective_project_id})
    if not project:
        return ApiFailResponse(
            message=f"Project not found: {effective_project_id}", status_code=404
        )

    resolved = list(participants or [])
    await _learn_address_book(resolved)

    derived_name = (title or "").strip() or (
        ", ".join(_participant_label(p) for p in resolved) or None
    )

    conv = Conversation.model_validate({
        "task_id": None,
        "project_id": project.id,
        "participants": resolved,
        # Stamp the shared context at create so the project chip + context
        # links resolve from the conversation itself (not only the first message).
        "shared_context_entities": list(shared_context_entities or []),
        # `title` is the user-set display title (NewConversationDialog).
        # `name` mirrors it for legacy consumers that still read `conv.name`.
        "title": (title or "").strip() or None,
        "name": derived_name,
    })
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(someone_typeid)
    await project.attach_child(conv)

    # Canonical jsonl path is auto-created under records-data root.
    jsonl_path = default_jsonl_path(conv.id)
    rec = from_jsonl(
        jsonl_path, project.id, conv.id, parent_type=RecordType.PROJECT
    )
    rec.save()

    return ApiSuccessResponse(data={
        "conversation_id": conv.id,
        "project_id": project.id,
        "participants": resolved,
        "name": conv.name,
    })


async def handle_conversation_dismiss(
    conversation_id: str, someone_typeid: str
) -> ApiResponse:
    """Stamp ``Conversation.dismissed_at = now()`` so the Recent strip hides
    this row until a FlowMessage newer than the stamp arrives. The Inbox
    ignores ``dismissed_at`` — Inbox dismissal is a separate concept driven
    by per-message ``is_archived``.
    """
    conversation_id = (conversation_id or "").strip()
    if not conversation_id:
        return ApiFailResponse(message="conversation_id required")
    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found")
    conv.dismissed_at = datetime.now(UTC)
    await conv.save(someone_typeid)
    return ApiSuccessResponse(data={
        "conversation_id": conversation_id,
        "dismissed_at": conv.dismissed_at.isoformat() if conv.dismissed_at else None,
    })


@action.post(action_name="conversation-dismiss", types=None)
async def conversation_dismiss() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        return await handle_conversation_dismiss(conv_id, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-dismiss error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_conversation_archive(
    conversation_id: str, someone_typeid: str
) -> ApiResponse:
    """Stamp ``Conversation.archived_at = now()``.

    Both Inbox and Recent strip hide the row when set; a FlowMessage newer
    than the stamp auto-revives it. Conversation-level archive — does NOT
    touch ``FlowMessage.is_read`` (those are per-message and remain
    independent). Idempotent: re-archiving already-archived row is a
    no-op (the stamp doesn't move backward in time, but the function
    re-stamps with the current time, which is harmless).
    """
    conversation_id = (conversation_id or "").strip()
    if not conversation_id:
        return ApiFailResponse(message="conversation_id required")
    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found")
    conv.archived_at = datetime.now(UTC)
    await conv.save(someone_typeid)
    return ApiSuccessResponse(data={
        "conversation_id": conversation_id,
        "archived_at": conv.archived_at.isoformat() if conv.archived_at else None,
    })


async def handle_conversation_unarchive(
    conversation_id: str, someone_typeid: str
) -> ApiResponse:
    """Clear ``Conversation.archived_at`` (back to ``None``).

    The manual inverse of :func:`handle_conversation_archive` — the same effect
    the auto-revive achieves when a newer FlowMessage arrives. Local-only (the
    hub never sees ``archived_at``). Idempotent: unarchiving a non-archived row
    re-stamps ``None``, which is harmless.
    """
    conversation_id = (conversation_id or "").strip()
    if not conversation_id:
        return ApiFailResponse(message="conversation_id required")
    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found")
    conv.archived_at = None
    await conv.save(someone_typeid)
    return ApiSuccessResponse(data={
        "conversation_id": conversation_id,
        "archived_at": None,
    })


async def handle_conversation_archive_all(someone_typeid: str) -> ApiResponse:
    """Stamp ``archived_at = now()`` on every Conversation that isn't
    already archived.

    Cheap on repeat clicks because conversations with a non-null
    ``archived_at`` are skipped — no SQLite write, no WS broadcast for
    rows that are already in the target state. Returns the count of rows
    that were freshly archived.
    """
    convs = await Conversation.get_all({})
    now = datetime.now(UTC)
    archived = 0
    for conv in convs or []:
        if conv.archived_at is not None:
            continue
        conv.archived_at = now
        await conv.save(someone_typeid)
        archived += 1
    return ApiSuccessResponse(data={
        "archived": archived,
        "scanned": len(convs or []),
        "archived_at": now.isoformat(),
    })


@action.post(action_name="conversation-archive", types=None)
async def conversation_archive() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        return await handle_conversation_archive(conv_id, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-archive error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-unarchive", types=None)
async def conversation_unarchive() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        return await handle_conversation_unarchive(conv_id, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-unarchive error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-archive-all", types=None)
async def conversation_archive_all() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_conversation_archive_all(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-archive-all error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def _hard_delete_local_conversation(conv: Conversation) -> None:
    """Hard-delete a local Conversation row + its FlowMessages + jsonl.

    Shared by the prune step in ``handle_conversation_list``, the per-row
    ``handle_conversation_delete`` action, and the bulk
    ``handle_conversation_delete_archived`` loop. Best-effort — exceptions
    in any sub-step are logged but don't abort the rest of the cleanup.
    """
    if conv is None or not conv.id:
        return
    cid = conv.id
    # Cascade: delete child FlowMessages so they don't orphan in SQLite.
    try:
        from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
        flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value, conversation_id=cid)
        msgs = await FlowMessage.get_all(flt)
        for fm in msgs:
            try:
                await fm.delete()
            except Exception as e:  # noqa: BLE001
                logger.warning("[conv-hard-delete] %s fm delete failed: %s", cid[:8], e)
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-hard-delete] %s fm list failed: %s", cid[:8], e)
    # Unlink the on-disk jsonl pointer index + parent dir if empty.
    try:
        jsonl_path = default_jsonl_path(cid)
        if jsonl_path.exists():
            jsonl_path.unlink()
        parent = jsonl_path.parent
        if parent.exists() and not any(parent.iterdir()):
            parent.rmdir()
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-hard-delete] %s jsonl unlink failed: %s", cid[:8], e)
    # Finally delete the entity row.
    try:
        await conv.delete()
    except Exception as e:  # noqa: BLE001
        logger.warning("[conv-hard-delete] %s entity delete failed: %s", cid[:8], e)


def _is_invitation_conversation(conv: Conversation) -> bool:
    """A conversation row that surfaces an invitation: it was materialized
    from a hub Invitation's embedded ``conversation`` payload AND the local
    user has not yet been added to ``participants`` (i.e. hasn't accepted).
    """
    if not conv:
        return False
    # The invitation pipeline materializes the conversation with a single
    # FlowMessage of kind='invitation'. The first-message kind isn't stored
    # on the Conversation row, so we infer the invitation state via the
    # local Invitation entity instead — there's exactly one invitation per
    # conversation in the new pipeline.
    return False


async def _classify_archived_delete(
    conv: Conversation, current_user_id: Optional[str]
) -> str:
    """Return one of: 'decline_invitation' | 'local' | 'delete_for_all' | 'leave'.

    Inspection order:
      1. Is this conversation the target of a still-pending Invitation that
         I (the local cloud user) have not accepted? → 'decline_invitation'.
      2. Is the conv local-only (``remote=False``)? → 'local'.
      3. Am I the hub-side owner (``conv.created_by == current_user_id``)?
         → 'delete_for_all'.
      4. Otherwise → 'leave'.
    """
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

    # Check pending invitation targeting this conv. We stored the conv id
    # via the invitation's ``message`` field as ``conversation-<id>`` in
    # ``Conversation.share`` — the most reliable disambiguator.
    if conv.remote:
        try:
            invs = await LocalInvitation.get_all({})
            for inv in (invs or []):
                if getattr(inv, "accepted", False):
                    continue
                msg = (getattr(inv, "message", None) or "").strip()
                if msg == f"conversation-{conv.id}":
                    return "decline_invitation"
        except Exception:  # noqa: BLE001
            pass
    if not conv.remote:
        return "local"
    if current_user_id and conv.created_by == current_user_id:
        return "delete_for_all"
    return "leave"


async def _current_cloud_user_id() -> Optional[str]:
    """Return the local cloud user's hub-side id, or None if not logged in."""
    try:
        from flow_sdk.cli.app_config import get_user  # noqa: PLC0415
        user = get_user() or {}
        uid = user.get("id")
        return uid if uid else None
    except Exception:  # noqa: BLE001
        return None


async def _hub_decline_invitation(invitation_id: str) -> None:
    """Class-level action — pending recipients have no entity role yet, so
    the hub registers ``decline`` as a class-action like ``pending``. We pass
    the invitation_id in the body."""
    await hub_post(
        BuiltinEntityType.INVITATION,
        {"invitation_id": invitation_id},
        action="decline",
    )


async def _hub_delete_conversation(conv_id: str) -> None:
    from flow_sdk.utils.hub import hub_delete  # noqa: PLC0415
    await hub_delete(BuiltinEntityType.CONVERSATION, conv_id, action="delete")


async def _hub_leave_conversation(conv_id: str) -> None:
    await hub_post(
        BuiltinEntityType.CONVERSATION, {}, entity_id=conv_id, action="leave",
    )


async def handle_conversation_delete_archived(someone_typeid: str) -> ApiResponse:
    """Best-effort bulk delete: classify each archived conversation, apply
    the correct hub-side action, then hard-delete locally only for items
    that succeeded hub-side.

    Returns per-item status:
      data = {
        "deleted": [<conv_id>, ...],
        "failed":  [{"id": <conv_id>, "reason": <str>}, ...],
        "scanned": <int>,
      }
    """
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415
    from flow_sdk.utils.hub import HubError, hub_base_url  # noqa: PLC0415

    convs = await Conversation.get_all({})
    targets = [c for c in (convs or []) if c.archived_at is not None]
    cloud_user_id = await _current_cloud_user_id()

    # Pre-check: if any target needs the hub but the hub isn't reachable,
    # bail with a structured error so the UI can surface the
    # "Cloud disconnected — Reconnect first" toast (decision #4a).
    any_needs_hub = False
    for c in targets:
        kind = await _classify_archived_delete(c, cloud_user_id)
        if kind in ("delete_for_all", "leave", "decline_invitation"):
            any_needs_hub = True
            break
    if any_needs_hub and not hub_base_url():
        return ApiFailResponse(
            data={"hub_reachable": False, "auth_required": False},
            message="Cloud disconnected — reconnect to delete shared conversations.",
        )

    deleted: list[str] = []
    failed: list[dict] = []
    for conv in targets:
        try:
            mode = await _classify_archived_delete(conv, cloud_user_id)
            if mode == "decline_invitation":
                inv = None
                try:
                    invs = await LocalInvitation.get_all({})
                    for cand in (invs or []):
                        if (getattr(cand, "message", None) or "").strip() == f"conversation-{conv.id}":
                            inv = cand
                            break
                except Exception:  # noqa: BLE001
                    pass
                if inv and inv.id:
                    await _hub_decline_invitation(inv.id)
                    try:
                        await inv.delete()
                    except Exception:  # noqa: BLE001
                        pass
                await _hard_delete_local_conversation(conv)
            elif mode == "delete_for_all":
                await _hub_delete_conversation(conv.id)
                await _hard_delete_local_conversation(conv)
            elif mode == "leave":
                await _hub_leave_conversation(conv.id)
                await _hard_delete_local_conversation(conv)
            else:  # mode == "local"
                await _hard_delete_local_conversation(conv)
            deleted.append(conv.id)
        except HubError as e:
            failed.append({"id": conv.id, "reason": f"hub {e.status_code}: {e.reason}"})
        except Exception as e:  # noqa: BLE001
            failed.append({"id": conv.id, "reason": str(e)})

    return ApiSuccessResponse(data={
        "deleted": deleted,
        "failed": failed,
        "scanned": len(convs or []),
    })


@action.post(action_name="conversation-delete-archived", types=None)
async def conversation_delete_archived() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_conversation_delete_archived(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-delete-archived error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_conversation_delete(
    conversation_id: str, mode: str, someone_typeid: str,
) -> ApiResponse:
    """Per-row delete with explicit semantics (mode in {delete_for_all, leave, local}).

    The UI picks the mode based on the user's relationship to the conversation:
      * ``delete_for_all`` — caller owns a shared conv (rule 1 cascade).
      * ``leave``          — caller is a non-owner participant (rule 3).
      * ``local``          — purely-local conv with no hub counterpart (rule 2).

    All non-``local`` modes pre-check hub reachability (decision #4a) and
    return ``{hub_reachable: false, auth_required}`` on failure so the UI
    can surface a clear toast instead of a transient error.
    """
    from flow_sdk.utils.hub import HubError, hub_base_url  # noqa: PLC0415

    if mode not in {"delete_for_all", "leave", "local"}:
        return ApiFailResponse(message=f"Unknown delete mode: {mode}")
    if not conversation_id:
        return ApiFailResponse(message="conversation_id is required")

    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        return ApiFailResponse(message="Conversation not found", data={"id": conversation_id})

    if mode != "local":
        if not hub_base_url():
            return ApiFailResponse(
                data={"hub_reachable": False, "auth_required": False, "id": conversation_id},
                message="Cloud disconnected — reconnect to delete shared conversations.",
            )
        try:
            if mode == "delete_for_all":
                await _hub_delete_conversation(conversation_id)
            else:  # mode == "leave"
                await _hub_leave_conversation(conversation_id)
        except HubError as e:
            return ApiFailResponse(
                data={"id": conversation_id, "hub_status": e.status_code},
                message=f"Hub {e.status_code}: {e.reason}",
            )

    await _hard_delete_local_conversation(conv)
    return ApiSuccessResponse(data={"id": conversation_id, "mode": mode})


@action.post(action_name="conversation-delete", types=None)
async def conversation_delete() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        mode = (body.get("mode") or "").strip()
        return await handle_conversation_delete(conv_id, mode, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-delete error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_remove_message(flow_message_id: str) -> ApiResponse:
    """Delete a single FlowMessage everywhere (rule: sender OR conversation owner).

    Local entrypoint behind the ``remove-message`` action. Flow:
      * gate locally on the resolved cloud-user id == ``fm.sender_id`` OR
        == ``conv.created_by`` (owner). Purely-local conversations have no
        cloud counterpart, so the local single user always passes.
      * for shared (``remote``) conversations, pre-check hub reachability then
        call ``Conversation.remove_message`` — the hub re-enforces the gate,
        deletes the hub-side FlowMessage and fans a DELETE op to participants.
      * always purge the local existence: ``fm.destroy()`` (DB row +
        relationships + on-disk record folder) and drop the conversation
        pointer (``prune_message_pointer`` re-projects with notify so the
        initiator's open view refreshes).
    """
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.utils.hub import HubError  # noqa: PLC0415

    fm_id = (flow_message_id or "").strip()
    if not fm_id:
        return ApiFailResponse(message="flow_message_id is required")

    fm = await FlowMessage.get_one({"id": fm_id})
    if fm is None:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)

    conv_id = (fm.conversation_id or "").strip()
    conv = await Conversation.get_one({"id": conv_id}) if conv_id else None

    # A purely-local conversation (no cloud counterpart, owner-less) is
    # single-user, so the gate + hub round-trip only apply to shared convs.
    if conv and getattr(conv, "remote", False):
        # Gate: deleter is the message sender OR the conversation owner. The
        # cloud user id is the authority for both. Owner = ``created_by``
        # matches (recipient-side, where the hub stamped the cloud-user id) OR
        # the caller holds role ``owner`` in the participant roster
        # (creator-side, where ``created_by`` is the local user id). The roster
        # is the hub-authoritative signal on both sides.
        cloud_user_id = await _current_cloud_user_id()
        is_sender = bool(cloud_user_id and fm.sender_id and cloud_user_id == fm.sender_id)
        is_owner = bool(
            cloud_user_id and (
                (conv.created_by and cloud_user_id == conv.created_by)
                or any(
                    (p or {}).get("user_id") == cloud_user_id
                    and str((p or {}).get("role") or "").lower() == "owner"
                    for p in (conv.participants or [])
                )
            )
        )
        if not (is_sender or is_owner):
            return ApiFailResponse(
                message="Only the message sender or the conversation owner can delete this message.",
                status_code=403,
            )

        # Delete for everyone via the hub (which re-enforces the gate and fans
        # the DELETE op out to all participants).
        if not hub_base_url():
            return ApiFailResponse(
                data={"hub_reachable": False, "auth_required": False, "id": fm_id},
                message="Cloud disconnected — reconnect to delete shared messages.",
            )
        try:
            await conv.remove_message(fm_id)
        except HubError as e:
            return ApiFailResponse(
                data={"id": fm_id, "hub_status": e.status_code},
                message=f"Hub {e.status_code}: {e.reason}",
            )

    # Purge the local existence (DB row + relationships + on-disk record folder).
    try:
        await fm.destroy()
    except Exception as e:  # noqa: BLE001
        logger.warning("[remove-message] local destroy failed fm=%s: %s", fm_id, e)

    # Drop the conversation pointer + re-project (notify so the open view updates).
    if conv_id:
        rec = FSRecord(type=RecordType.CONVERSATION, id=conv_id)
        try:
            await prune_message_pointer(rec, fm_id, notify=True)
        except Exception as e:  # noqa: BLE001
            logger.warning("[remove-message] pointer prune failed fm=%s conv=%s: %s", fm_id, conv_id, e)

    return ApiSuccessResponse(data={"flow_message_id": fm_id, "conversation_id": conv_id})


@action.post(action_name="remove-message", types=["flow_message"])
async def remove_message() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        fm_id = (body.get("flow_message_id") or "").strip()
        # The action target id (flow_message-<id>) is the fallback when the
        # body omits the explicit field — the UI calls it on the message entity.
        if not fm_id:
            tgt = getattr(request_info, "target_entity_typeid", None)
            if tgt is not None and getattr(tgt, "id", None):
                fm_id = str(tgt.id).strip()
        return await handle_remove_message(fm_id)
    except Exception as e:
        logger.error("[flow_message_action] remove-message error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_invitation_decline(
    invitation_id: str, someone_typeid: str,
) -> ApiResponse:
    """Decline a pending invitation hub-side AND remove the local row
    (along with the embedded Conversation + preview message that the
    new invitation pipeline materialized).
    """
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415
    from flow_sdk.utils.hub import HubError, hub_base_url  # noqa: PLC0415

    if not invitation_id:
        return ApiFailResponse(message="invitation_id is required")
    if not hub_base_url():
        return ApiFailResponse(
            data={"hub_reachable": False, "auth_required": False, "id": invitation_id},
            message="Cloud disconnected — reconnect to decline invitations.",
        )
    try:
        await _hub_decline_invitation(invitation_id)
    except HubError as e:
        return ApiFailResponse(
            data={"id": invitation_id, "hub_status": e.status_code},
            message=f"Hub {e.status_code}: {e.reason}",
        )

    # Locate the local invitation + its target conversation (the conv id
    # is stamped into the invitation message via ``Conversation.share``).
    try:
        inv = await LocalInvitation.get_one({"id": invitation_id})
    except Exception:  # noqa: BLE001
        inv = None
    target_conv_id: Optional[str] = None
    if inv is not None:
        msg = (getattr(inv, "message", None) or "").strip()
        if msg.startswith("conversation-"):
            target_conv_id = msg.removeprefix("conversation-")
        try:
            await inv.delete()
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-decline] local inv delete failed: %s", e)
    if target_conv_id:
        try:
            conv = await Conversation.get_one({"id": target_conv_id})
            if conv is not None:
                await _hard_delete_local_conversation(conv)
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-decline] local conv cleanup failed: %s", e)

    return ApiSuccessResponse(data={"id": invitation_id})


@action.post(action_name="invitation-decline", types=None)
async def invitation_decline() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        inv_id = (body.get("invitation_id") or "").strip()
        return await handle_invitation_decline(inv_id, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] invitation-decline error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-create", types=None)
async def conversation_create() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        body = await request_info.get_post_data() or {}
        project_id = (body.get("project_id") or "").strip()
        shared_context_entities = body.get("shared_context_entities") or []
        if not isinstance(shared_context_entities, list):
            return ApiFailResponse(message="shared_context_entities must be a list")
        # ``project_id`` is the ambient fallback; a shared entity can supply the
        # project instead, so it's required only when nothing is shared.
        if not project_id and not shared_context_entities:
            return ApiFailResponse(message="project_id is required")
        participants = body.get("participants") or []
        if not isinstance(participants, list):
            return ApiFailResponse(message="participants must be a list")
        title = (body.get("title") or "").strip() or None

        return await handle_create_project_conversation(
            project_id=project_id,
            participants=participants,
            someone_typeid=request_info.someone_typeid,
            title=title,
            shared_context_entities=shared_context_entities,
        )
    except Exception as e:
        logger.error("[flow_message_action] conversation-create error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to create conversation: {str(e)}")


# ---------------------------------------------------------------------------
# Community / support-center actions
# ---------------------------------------------------------------------------

async def _hub_action(method: str, path: str, body: Optional[dict] = None, timeout: float = 10.0) -> Optional[dict]:
    """Authenticated HTTP call to a hub action; returns the parsed ApiResponse
    envelope (``{"status","message","data"}``) or ``None`` on transport failure.

    Community queue/ticket actions are request/response project actions — HTTP is
    a better fit (and more robust) than the message-fanout WS bridge, which is
    reserved for the add_message fast-path. Mirrors the authed-httpx pattern in
    ``notification_action._hub_knows_conversation``."""
    try:
        import httpx  # noqa: PLC0415

        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        from flow_sdk.cloud_client.client import ApiConfig  # noqa: PLC0415

        creds = load_credentials()
        if not creds or not creds.api_key:
            return None
        url = ApiConfig.from_env()._get_full_url(path)
        headers = {
            "Authorization": f"Bearer {creds.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }
        async with httpx.AsyncClient(timeout=timeout) as h:
            r = await h.request(method, url, headers=headers, json=None if method == "GET" else (body or {}))
            return r.json()
    except Exception as e:  # noqa: BLE001
        logger.warning("[community] hub %s %s failed: %s", method, path, e)
        return None


_COMMUNITY_PROJECT_ID_CACHE: Optional[str] = None


async def _resolve_community_project_id() -> Optional[str]:
    """The fixed community/support project id, learned from the hub's
    ``/version`` (``community_project_id``). ``None`` when the hub is
    unreachable or doesn't advertise one. See CommunityConfig and the hub's
    ``ensure_community_project``.

    Cached for the process lifetime once resolved — it's a deployment constant,
    so re-fetching ``/version`` on every ticket open / queue poll is wasted I/O.
    A miss is not cached, so a transient hub outage retries next call."""
    global _COMMUNITY_PROJECT_ID_CACHE
    if _COMMUNITY_PROJECT_ID_CACHE:
        return _COMMUNITY_PROJECT_ID_CACHE
    try:
        from flow_sdk.cloud_client.transport.hub_http import get_info  # noqa: PLC0415
        info = await get_info() or {}
        cid = info.get("community_project_id")
        if isinstance(cid, str) and cid.strip():
            _COMMUNITY_PROJECT_ID_CACHE = cid
            return cid
        return None
    except Exception:  # noqa: BLE001
        return None


@action.post(action_name="community-start-ticket", types=None)
async def community_start_ticket() -> ApiResponse:
    """Open a support ticket — a guest-authored ``community`` conversation under
    the hub's fixed community project.

    Routes through the hub (``Project.start_guest_conversation``), then
    materializes the conversation + first message locally as a hub-mirrored
    ``kind=community`` row so it appears in the guest's UI immediately (the hub
    fanout skips the sender, so the local backend is this row's source of
    truth). Returns the new conversation id for navigation.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        someone_typeid = request_info.someone_typeid

        body = await request_info.get_post_data() or {}
        text = (body.get("text") or body.get("message") or "").strip()
        if not text:
            return ApiFailResponse(message="text is required")

        community_id = await _resolve_community_project_id()
        if not community_id:
            return ApiFailResponse(message="Community support is unavailable on this hub")

        resp = await _hub_action(
            "POST", f"/graph/project/{community_id}/start_guest_conversation", {"text": text}
        )
        if not resp or resp.get("status") != "SUCCESS":
            msg = (resp or {}).get("message") or "hub unreachable"
            return ApiFailResponse(message=f"Could not open support ticket: {msg}")
        conv_data = resp.get("data") or {}
        conv_id = conv_data.get("id")
        if not conv_id:
            return ApiFailResponse(message="Hub did not return a conversation")

        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415
        hub_ws_bridge.remember_hub_conversation(conv_id)

        from flow_sdk.app.actions.materialize_flow_message import ensure_conversation_entity  # noqa: PLC0415
        from flow_sdk.builtin.conversation import ConversationKind  # noqa: PLC0415

        title = text if len(text) <= 60 else f"{text[:60].rstrip()}…"
        # Hub-owned conversation: no local project_id (mirrors how received
        # remote conversations materialize); carry the community project as the
        # remote project identity for traceability.
        await ensure_conversation_entity(
            conv_id,
            parent_typeid=None,
            remote_project_id=community_id,
            title=title,
            someone_typeid=someone_typeid,
        )

        # Pull the first (guest) message from the hub into the local store. Do
        # this BEFORE stamping kind/remote — the message sync re-materializes the
        # conversation from the hub and would otherwise clobber kind back to the
        # default. Our stamp must be the LAST write.
        try:
            await _fetch_conversation_messages(conv_id, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[community-start-ticket] message sync failed (non-fatal): %s", e)

        conv = await Conversation.get_one({"id": conv_id})
        if conv:
            conv.kind = ConversationKind.COMMUNITY
            conv.remote = True
            # Carry the hub owner VERBATIM when present; never mask a genuinely
            # null hub owner with a stale local value. Reflection keeps the
            # save from re-stamping updated_by with the local user.
            if conv_data.get("initiated_by") is not None:
                conv.created_by = conv_data["initiated_by"]
            with remote_reflection():
                await conv.save(someone_typeid, notify=False)

        return ApiSuccessResponse(data={"conversation_id": conv_id, "project_id": community_id})
    except Exception as e:
        logger.error("[flow_message_action] community-start-ticket error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to start support ticket: {str(e)}")


@action.post(action_name="conversation-pickup", types=None)
async def conversation_pickup() -> ApiResponse:
    """Staff-side: pick up (join) a community ticket so the caller starts
    receiving its messages and can reply. Proxies to the hub ``pickup`` action,
    then syncs the conversation's messages locally. Hub gates on project
    membership."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        someone_typeid = request_info.someone_typeid

        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        if not conv_id:
            return ApiFailResponse(message="conversation_id is required")

        resp = await _hub_action("POST", f"/graph/conversation/{conv_id}/pickup", {})
        if not resp or resp.get("status") != "SUCCESS":
            msg = (resp or {}).get("message") or "hub unreachable"
            return ApiFailResponse(message=f"Could not pick up conversation: {msg}")

        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415
        hub_ws_bridge.remember_hub_conversation(conv_id)
        try:
            await _fetch_conversation_messages(conv_id, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[conversation-pickup] message sync failed (non-fatal): %s", e)
        return ApiSuccessResponse(data={"conversation_id": conv_id})
    except Exception as e:
        logger.error("[flow_message_action] conversation-pickup error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to pick up conversation: {str(e)}")


@action.post(action_name="community-tickets-list", types=None)
async def community_tickets_list() -> ApiResponse:
    """Staff triage queue: list the community project's tickets (members-only on
    the hub). Returns the lightweight rows verbatim so the UI can render an
    "unpicked" queue — unpicked tickets don't fan out to non-participants, so
    this is the only way staff discover them. Picking one up materializes it
    locally (see ``conversation-pickup``)."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        community_id = await _resolve_community_project_id()
        if not community_id:
            return ApiFailResponse(message="Community support is unavailable on this hub")

        resp = await _hub_action("GET", f"/graph/project/{community_id}/community_conversations")
        rows = (resp or {}).get("data") or []
        if not isinstance(rows, list):
            rows = []
        return ApiSuccessResponse(data={"tickets": rows, "project_id": community_id})
    except Exception as e:
        logger.error("[flow_message_action] community-tickets-list error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to list community tickets: {str(e)}")


# ---------------------------------------------------------------------------
# Inbox actions
# ---------------------------------------------------------------------------

def _last_fetch_path() -> Path:
    return get_instance_settings().inbox_last_fetch_path


def _load_last_fetch() -> Optional[str]:
    """Return ISO timestamp of last successful hub fetch, or None."""
    try:
        if _last_fetch_path().exists():
            return _json.loads(_last_fetch_path().read_text()).get("last_fetch")
    except Exception:
        pass
    return None


def _save_last_fetch(ts: str) -> None:
    _last_fetch_path().parent.mkdir(parents=True, exist_ok=True)
    _last_fetch_path().write_text(_json.dumps({"last_fetch": ts}))


async def _download_and_unpack_bundle(
    fm_id: str,
    attachment_filename: str,
    *,
    body_status: "str | BodyStatus | None" = None,
    overwrite: bool = False,
    raise_on_conflict: bool = False,
    raise_on_no_project: bool = False,
    on_progress=None,
) -> bool:
    """Download the .flowmsg bundle from the hub and unpack it locally.

    Returns True if the bundle was successfully unpacked, False otherwise.

    ``body_status`` — the hub-side body lifecycle for this message. This is the
    SINGLE backend gate: when it's anything other than READY there is no bundle
    on the hub to pull (``na`` = none was ever uploaded, ``uploading`` = not yet
    landed), so we skip the GET entirely rather than 404. Every implicit caller
    (open / inbox-open / conversation-sync / invitation-accept / catch-up / the
    eager-pull bridge) forwards what it already read from the hub payload; the
    explicit ``download_body`` path forwards its own READY status. ``None`` means
    "caller did not supply a status" and proceeds unchanged (back-compat).

    File-backed assets in the bundle are copied into the conversation's mapped
    PROJECT and indexed there (``unpack_bundle``). When no project is mapped the
    assets are parked; ``raise_on_no_project`` (the explicit ``download_body``
    path) then re-raises ``FlowMessageNoProjectError`` so the caller can prompt
    "map a project first" and re-download. Implicit callers swallow it (parked).

    ``on_progress`` — optional async callback fired as download bytes land;
    when set the hub GET is streamed instead of buffered whole.
    """
    from flow_sdk.builtin.flow_message_bundle import (
        FlowMessageExistsError, FlowMessageNoProjectError, unpack_bundle,
    )

    if body_status is not None:
        bs = body_status.value if isinstance(body_status, BodyStatus) else body_status
        if bs != BodyStatus.READY.value:
            logger.debug(
                "[bundle] skip download fm=%s — body_status=%s (no bundle to pull)",
                fm_id, bs,
            )
            return False
    bundle_bytes = await hub_get(
        BuiltinEntityType.FLOW_MESSAGE, fm_id, "fs", f"download/{attachment_filename}",
        raw=True, on_progress=on_progress,
    )
    if not bundle_bytes:
        logger.warning("[bundle] download returned no bytes for fm=%s", fm_id)
        return False
    local_user = await User.get_one({"uname": "local"})
    local_user_id = local_user.id if local_user else ""
    with tempfile.NamedTemporaryFile(suffix=".flowmsg", delete=False) as tmp:
        tmp_path = Path(tmp.name)
        tmp.write(bundle_bytes)
    try:
        await unpack_bundle(
            tmp_path, local_user_id, overwrite=overwrite,
            raise_on_no_project=raise_on_no_project,
        )
        # Bundle bytes are on disk now. The FM's ``attachment[].local_path``
        # is computed lazily by the model serializer from disk state, so the
        # cached browser entity still reads ``local_path=null`` from the
        # earlier WS create. Fan a fresh UPDATE so subscribers re-render with
        # the populated path — without this, image attachments stay as a
        # generic file chip until a manual refresh re-fetches the FM.
        try:
            refreshed = await FlowMessage.get_one({"id": fm_id})
            if refreshed:
                await refreshed.notify_updated()
        except Exception as nerr:
            logger.warning("[bundle] post-unpack notify failed fm=%s: %s", fm_id, nerr)
        return True
    except FlowMessageExistsError:
        # A GENUINE collision: a different asset already occupies the receiver's
        # target path (byte-identical re-receives are now no-ops in
        # ``_restore_file_backed_entry`` and never reach here). This is NOT
        # success — swallowing it as True was the bug that silently dropped the
        # shared asset and left the receiver pointed at their own pre-existing
        # one. The explicit ``download_body`` path re-raises so the caller can
        # surface "asset already exists — overwrite?" and retry with
        # overwrite=True; implicit auto-materialize callers log + report failure
        # (False) instead of crashing a background sync.
        if raise_on_conflict:
            raise
        logger.warning(
            "[bundle] unpack conflict fm=%s — asset already exists at target; "
            "not materialized (retry with overwrite to replace)", fm_id,
        )
        return False
    except FlowMessageNoProjectError:
        # File-backed assets were extracted but the conversation isn't mapped to
        # a project — they're parked (the FM still materialized). The explicit
        # download path re-raises so the UI can prompt "map a project first" and
        # re-download; implicit auto-callers leave the asset parked and report
        # not-fully-materialized (False) without crashing the sync.
        if raise_on_no_project:
            raise
        logger.info("[bundle] assets parked fm=%s — no project mapped yet", fm_id)
        return False
    except ValueError as e:
        # Legacy bundles (pre-header.json) raise "Invalid .flowmsg: missing
        # header.json". Per the no-legacy-support rule, drop them silently
        # rather than logging a stack trace.
        if "missing header.json" in str(e):
            return False
        logger.error("[bundle] unpack failed fm=%s: %s", fm_id, e, exc_info=True)
        return False
    except Exception as e:
        logger.error("[bundle] unpack failed fm=%s: %s", fm_id, e, exc_info=True)
        return False
    finally:
        tmp_path.unlink(missing_ok=True)


async def handle_inbox_list() -> ApiResponse:
    """Return non-archived received FlowMessages whose Conversation exists locally, newest first.

    FMs whose ``conversation_id`` does not resolve to a locally-known Conversation
    are filtered out so the sidebar badge stays aligned with what InboxView can
    actually render (which iterates Conversation entities). Without this gate the
    badge counted orphan FMs the user had no way to open or dismiss.
    """
    from flow_sdk.db.drivers.query import QueryFilter
    current_user = await User.get_one({"uname": "local"})
    current_user_id = current_user.id if current_user else None
    flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value)
    all_messages = await FlowMessage.get_all(flt)
    conv_flt = QueryFilter(type=BuiltinEntityType.CONVERSATION.value)
    known_conv_ids = {c.id for c in await Conversation.get_all(conv_flt)}
    messages = [
        m for m in all_messages
        if not m.is_archived
        and m.sender_id != current_user_id
        and m.conversation_id in known_conv_ids
    ]
    messages.sort(key=lambda m: m.created_date or "", reverse=True)
    return ApiSuccessResponse(data=[m.model_dump(mode="json") for m in messages])


@action.get(action_name="inbox-list", types=None)
async def inbox_list() -> ApiResponse:
    try:
        return await handle_inbox_list()
    except Exception as e:
        logger.error("[flow_message_action] inbox-list error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to list inbox: {str(e)}")


async def _fetch_raw_messages_from_hub(since: str | None) -> list[dict] | None:
    """Call hub for FlowMessages newer than `since`.

    Returns the list of raw message dicts, or None if the hub is unavailable.
    """
    params: dict = {"since": since} if since else {}
    result = await hub_get(BuiltinEntityType.FLOW_MESSAGE, params=params)
    if result is None:
        return None
    return result if isinstance(result, list) else []


async def _process_single_hub_message(raw: dict) -> str | None:
    """Download and unpack the .flowmsg bundle for one hub FlowMessage.

    Returns the fm_id if the bundle was processed (or was already materialized),
    or None if the message was skipped or the download/unpack failed.

    Two paths:
      1. ``attachment_filename`` set → standard bundle download + unpack.
      2. No bundle (text-only or TYPE_ID-only attachments) → materialise the
         FlowMessage row directly from the hub payload so the conversation
         view can render it. Older versions skipped these entirely, which
         dropped every hub message from the sender's own catch-up (their
         locally-sent messages never produce a bundle) and every pure-text
         reply from a peer.
    """
    fm_id = (raw.get("id") or "").strip()
    if not fm_id:
        return None
    existing = await FlowMessage.get_one({"id": fm_id})
    # Body first, metadata second — and the two are INDEPENDENT. The body
    # check must not be keyed on row existence: a row materialized while the
    # sender was still uploading (bridge CREATE with body_status=uploading)
    # would otherwise never auto-download its bundle on any later pass,
    # leaving every bundled entity (task / spec / transcript) unmaterialized
    # until a manual click. Pull whenever the hub advertises a bundle that
    # isn't fully on disk yet — ``_download_and_unpack_bundle`` gates on
    # body_status=READY itself, and ``unpack_bundle`` is idempotent for
    # re-unpacks (existing rows merge, attachments fill in).
    attachment_filename = (raw.get("attachment_filename") or "").strip()
    if attachment_filename:
        downloaded = existing is not None and existing.is_body_downloaded()
        if not downloaded:
            success = await _download_and_unpack_bundle(
                fm_id, attachment_filename, body_status=raw.get("body_status"),
            )
            if existing is None:
                # unpack materializes the FM row itself on success; on failure
                # (body still uploading, transient hub error) leave nothing
                # behind — the next sync pass retries.
                return fm_id if success else None
    if existing is not None and not FlowMessage.is_stale(existing, raw):
        # Metadata current (body handled above).
        return fm_id
    # Bundle-less: persist the FM payload as-is, then append the pointer to
    # the conversation's message_ids JSON projection. We DO NOT route through
    # materialize_flow_message / _append_message_to_conversation here —
    # those are the local-send path which owns id allocation and would mint
    # a fresh FM with a new UUID if the upsert lookup misses for any reason
    # (we saw it produce duplicate rows for every hub message). The
    # catch-up contract is the opposite: the hub-side id is authoritative
    # and must round-trip unchanged into both the entities table AND the
    # conv's pointer list.
    try:
        if existing is not None:
            # Stale existing row → LWW refresh: pull hub-owned fields, preserve
            # local-only state (body_status/is_read/...), carry hub updated_date.
            payload = FlowMessage.merge_hub_payload(existing, raw)
            payload["remote"] = True
        else:
            payload = {**raw, "remote": True}
        fm = FlowMessage.model_validate(payload)
        await fm.save()
    except Exception as e:  # noqa: BLE001
        logger.warning("[fm-process] bundle-less fm=%s save failed: %s", fm_id[:8], e)
        return None
    conv_id = (raw.get("conversation_id") or "").strip()
    if conv_id:
        try:
            # Canonical write path for the message_ids / message_count
            # projection — same pattern materialize_flow_message uses on
            # the local-send side. We write the pointer to the on-disk
            # conversation.jsonl and let ConversationRecord.sync_to_db
            # bump the projection on the Conversation entity (direct
            # writes are blocked by Conversation.__setattr__'s projection
            # guard at conversation.py:252).
            rec = from_jsonl(
                default_jsonl_path(conv_id),
                parent_id="", record_id=conv_id, parent_type=RecordType.PROJECT,
            )
            existing_ids = {p.id for p in message_pointers(rec)}
            if fm_id not in existing_ids:
                ts = raw.get("created_date") or ""
                append_message_pointer(rec, fm_id, ts)
                await rec.sync_to_db(notify=False)
                await project_pointers_to_entity(rec, notify=False)
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "[fm-process] pointer-append for conv=%s fm=%s failed: %s",
                conv_id[:8], fm_id[:8], e,
            )
    return fm_id


async def handle_inbox_fetch(someone_typeid: str) -> ApiResponse:
    """**Deprecated** — prefer ``conversation-list``.

    Still wired up for the in-process ``notification_scanner`` background
    sweep, which relies on the legacy ``{created, ids}`` return shape. New
    UI call sites should go through ``conversation-list`` instead, which
    fans out per-conversation bundle fetches in the background and returns
    the merged list inline.
    """
    since = _load_last_fetch()
    fetch_started = datetime.now(UTC).isoformat()

    raw_messages = await _fetch_raw_messages_from_hub(since)
    if raw_messages is None:
        return ApiFailResponse(message="Hub unavailable or not configured")

    created_ids: list[str] = []
    for raw in raw_messages:
        try:
            processed_id = await _process_single_hub_message(raw)
            if processed_id:
                created_ids.append(processed_id)
        except Exception as e:
            logger.warning("[inbox-fetch] failed to process fm=%s: %s", (raw.get("id") or "?"), e)

    _save_last_fetch(fetch_started)
    return ApiSuccessResponse(data={"created": len(created_ids), "ids": created_ids})


async def handle_inbox_open(fm_id: str) -> ApiResponse:
    """Materialise the task for a FlowMessage and return {task_id, conversation_id}."""

    # Prefer local FM (reply messages are local-only); hub is fallback for inbox messages.
    local_fm = await FlowMessage.get_one({"id": fm_id})
    if local_fm:
        attachment_filename = (local_fm.attachment_filename or "").strip()
        body_status = local_fm.body_status
        raw_context = [str(c) for c in (local_fm.shared_context_entities or [])]
    else:
        hub_data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
        attachment_filename = ((hub_data or {}).get("attachment_filename") or "").strip()
        body_status = (hub_data or {}).get("body_status")
        # Tolerate both new and legacy hub field names during transition.
        raw_context = (
            (hub_data or {}).get("shared_context_entities")
            or (hub_data or {}).get("context_entities")
            or []
        )

    task_id = None
    conv_id = None
    for c in raw_context:
        try:
            tid = TypeId(c)
            if tid.type == BuiltinEntityType.TASK.value:
                task_id = tid.id
            elif tid.type == BuiltinEntityType.CONVERSATION.value:
                conv_id = tid.id
        except Exception:
            pass

    needs_task_bundle = bool(task_id) and not await Task.get_one({"id": task_id})
    needs_fm_bundle = local_fm is None
    if attachment_filename and (needs_task_bundle or needs_fm_bundle):
        await _download_and_unpack_bundle(fm_id, attachment_filename, body_status=body_status)

    return ApiSuccessResponse(data={"task_id": task_id, "conversation_id": conv_id})


@action.get(action_name="inbox-open", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def inbox_open() -> ApiResponse:
    """Materialize the task referenced by a FlowMessage (downloads bundle if needed)."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found", status_code=400)
        return await handle_inbox_open(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error("[flow_message_action] inbox-open error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Open failed: {str(e)}")


@action.post(action_name="inbox-fetch", types=None)
async def inbox_fetch() -> ApiResponse:
    """Fetch new FlowMessages from hub since last check."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_inbox_fetch(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] inbox-fetch error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Fetch failed: {str(e)}")


async def handle_inbox_update(fm_id: str, patch: dict, someone_typeid: str) -> ApiResponse:
    """Apply is_read / is_archived patch to a single FlowMessage."""
    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    if "is_read" in patch:
        fm.is_read = bool(patch["is_read"])
    if "is_archived" in patch:
        fm.is_archived = bool(patch["is_archived"])
    await fm.save(someone_typeid)
    return ApiSuccessResponse(data={"id": fm_id, "is_read": fm.is_read, "is_archived": fm.is_archived})


@action.post(action_name="inbox-update", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def inbox_update() -> ApiResponse:
    """Update is_read / is_archived on a single FlowMessage."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No target entity")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        fm_id = str(request_info.target_entity_typeid.id)
        patch = await request_info.get_post_data() or {}
        return await handle_inbox_update(fm_id, patch, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] inbox-update error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Update failed: {str(e)}")


@action.post(action_name="mark_received", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def mark_received_action() -> ApiResponse:
    """UI-side read-ack: forwards the batch to the hub via the WS bridge.

    Body: ``{flow_message_ids: list[str]}``. The hub honors monotonicity +
    sender-skip server-side, so re-acking already-received or own-sent
    messages is a cheap no-op. Returns the hub's ``{updated, skipped}``
    payload unchanged when the bridge is verified, or a graceful no-op
    when the hub WS is offline.
    """
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info")
        body = await request_info.get_post_data() or {}
        ids = body.get("flow_message_ids") or []
        if not isinstance(ids, list) or not all(isinstance(x, str) for x in ids):
            return ApiFailResponse(message="flow_message_ids must be a list of strings", status_code=400)
        if not ids:
            return ApiSuccessResponse(data={"updated": [], "skipped": []})

        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        if not hub_ws_manager.is_connected:
            # Bridge not connected — degrade gracefully. The next reconnect's
            # catch-up cycle will re-emit acks for any unprocessed messages.
            return ApiSuccessResponse(data={"updated": [], "skipped": [
                {"id": i, "reason": "hub_ws_offline"} for i in ids
            ]})

        result = await hub_ws_bridge.mark_received(flow_message_ids=ids, timeout=5.0)
        # Hub returns the raw ApiResponse shape: {"status": "...", "data": {...}}
        if isinstance(result, dict) and "data" in result and isinstance(result["data"], dict):
            return ApiSuccessResponse(data=result["data"])
        return ApiSuccessResponse(data=result if isinstance(result, dict) else {})
    except Exception as e:
        logger.error("[flow_message_action] mark_received error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"mark_received failed: {str(e)}")


async def handle_send_draft(fm_id: str, someone_typeid: str) -> ApiResponse:
    """Promote a draft FlowMessage to a real reply.

    1. Validate `is_draft=True`.
    2. Append a pointer to `conversation.jsonl` and bump
       `Conversation.message_ids` / `message_count`.
    3. Flip `is_draft=False`; save.
    4. Notify the UI; the hub-side header is created by
       ``_send_conversation_message_header`` when the conversation is remote.
    """
    from flow_sdk.app.actions.notification_action import (
        _append_message_to_conversation,
        _notify_ui_conversation_updated,
        _send_conversation_message_header,
    )
    from flow_sdk.cli.auth.hub_login import is_logged_in

    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    if not fm.is_draft:
        return ApiFailResponse(message="FlowMessage is not a draft")
    if not fm.conversation_id:
        return ApiFailResponse(message="Draft has no conversation_id")

    conv = await Conversation.get_one({"id": fm.conversation_id})
    if not conv:
        return ApiFailResponse(message=f"Conversation not found: {fm.conversation_id}")

    fm.is_draft = False

    # For remote conversations, attempt the hub send BEFORE committing any
    # local state. ``_send_conversation_message_header`` returns False on
    # any failure; in that case we abort cleanly — the FM row stays as a
    # draft in DB (the in-memory ``is_draft=False`` is discarded), no
    # pointer is appended, and the user can retry. This prevents the
    # phantom "local says sent, hub doesn't know" state and avoids
    # orphaning a pointer to a still-draft row.
    if getattr(conv, "remote", False) and is_logged_in():
        if not await _send_conversation_message_header(conv, fm):
            return ApiFailResponse(
                message="Hub send failed; draft preserved for retry",
                status_code=503,
            )
        # Hub confirmed. Mark the local row as a hub mirror so re-sync
        # treats it as a refreshable counterpart (same as received messages).
        fm.remote = True

    # Persist the finalised FM (is_draft=False, possibly remote=True) BEFORE
    # appending the pointer, so the pointer projection sees the sent state
    # instead of the still-draft state.
    fm = await fm.save(someone_typeid)

    conv = await _append_message_to_conversation(
        conv=conv,
        fm_id=fm.id,
        someone_typeid=someone_typeid,
    )

    _notify_ui_conversation_updated(conv.id, "", fm.id)

    return ApiSuccessResponse(data={
        "flow_message_id": fm.id,
        "conversation_id": conv.id,
        "message_count": conv.message_count,
    })


@action.post(action_name="send-draft", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def send_draft() -> ApiResponse:
    """Promote a draft FlowMessage to a real reply (jsonl pointer + hub push)."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        from flow_sdk.cli.auth.hub_login import is_logged_in
        if not is_logged_in():
            return ApiFailResponse(message="Cloud login required to send messages")
        return await handle_send_draft(
            fm_id=str(request_info.target_entity_typeid.id),
            someone_typeid=request_info.someone_typeid,
        )
    except Exception as e:
        logger.error("[flow_message_action] send-draft error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Send draft failed: {str(e)}")


async def handle_inbox_bulk_update(patch: dict, someone_typeid: str) -> ApiResponse:
    """Apply is_read / is_archived patch to all FlowMessages."""
    from flow_sdk.db.drivers.query import QueryFilter
    flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value)
    messages = await FlowMessage.get_all(flt)
    count = 0
    for fm in messages:
        changed = False
        if "is_read" in patch:
            fm.is_read = bool(patch["is_read"])
            changed = True
        if "is_archived" in patch:
            fm.is_archived = bool(patch["is_archived"])
            changed = True
        if changed:
            await fm.save(someone_typeid)
            count += 1
    return ApiSuccessResponse(data={"updated": count})


@action.post(action_name="inbox-bulk-update", types=None)
async def inbox_bulk_update() -> ApiResponse:
    """Bulk update is_read / is_archived across all FlowMessages."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        patch = await request_info.get_post_data() or {}
        return await handle_inbox_bulk_update(patch, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] inbox-bulk-update error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Bulk update failed: {str(e)}")


# ---------------------------------------------------------------------------
# Hub-mirrored conversations (Entity.remote=True). Sender, receiver, reply,
# and invitation-accept paths. These do NOT use the .flowmsg bundle flow —
# the hub holds a Conversation entity and its FlowMessages, both sides keep
# a local mirror with the hub-allocated ids.
# ---------------------------------------------------------------------------


def _membership_cls(target_type: str | None):
    """Entity class for a membership target type (organization → Organization, else Team)."""
    return Organization if target_type == BuiltinEntityType.ORGANIZATION.value else Team


async def _materialize_membership_invitation(
    hub_inv: dict, target: dict, someone_typeid: str
) -> Optional["Invitation"]:
    """Upsert a hub organization/team Invitation locally (``remote=True``).

    Unlike conversation invitations, membership invitations have no backing
    conversation: the inbox renders a generic row straight off the Invitation's
    ``target_*`` fields. We also mirror the target org/team locally so the row
    can show its name/icon and so accept resolves a real entity.
    """
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415
    from flow_sdk.app.actions.membership_sync import (  # noqa: PLC0415
        materialize_remote_membership_entity,
    )

    inv_id = hub_inv["id"]
    target_type = target.get("type")
    target_id = target.get("id")
    target_name = target.get("name")
    target_role = target.get("role")

    # Mirror the target org/team so name/icon resolve locally (best-effort —
    # the invitation row still renders from target_* even if this fails).
    try:
        cls = _membership_cls(target_type)
        await materialize_remote_membership_entity(
            cls,
            {"id": target_id, "name": target_name, "icon": target.get("icon")},
            someone_typeid,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("[inv-materialize] membership target mirror failed: %s", e)

    fields = {
        "recipient_email": hub_inv.get("recipient_email") or "",
        "accepted": bool(hub_inv.get("accepted") or False),
        "sent": bool(hub_inv.get("sent") or False),
        "message": hub_inv.get("message"),
        "target_type": target_type,
        "target_id": target_id,
        "target_name": target_name,
        "target_role": target_role,
        "remote": True,
    }
    existing_inv = await LocalInvitation.get_one({"id": inv_id})
    if existing_inv:
        for k, v in fields.items():
            setattr(existing_inv, k, v)
        return await existing_inv.save(someone_typeid)
    return await LocalInvitation.model_validate({"id": inv_id, **fields}).save(someone_typeid)


async def _materialize_invitation(
    hub_inv: dict, someone_typeid: str
) -> tuple[Optional["Invitation"], Optional[str]]:
    """Upsert a hub-side Invitation locally — and the Conversation + preview
    FlowMessage that the hub now ships embedded in the ``pending`` response.

    Returns ``(local_invitation, conversation_id)``. ``conversation_id`` is
    None when the hub didn't embed a target Conversation (defensive — older
    hub builds without the embedding change still work, the placeholder is
    just not materialized).

    Decision #2 in the plan: invitations carry the real Conversation, so
    the recipient sees a normal ``remote=True`` Conversation row with the
    first FlowMessage already present, no synthesized "placeholder" id.
    """
    from flow_sdk.app.actions.materialize_flow_message import (  # noqa: PLC0415
        materialize_flow_message,
    )
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

    if not hub_inv or not hub_inv.get("id"):
        return None, None
    inv_id = hub_inv["id"]

    # Membership invitations (organization / team) carry a ``target`` descriptor
    # instead of a conversation. Materialize the Invitation with its target
    # metadata (so the inbox renders a generic "Organization/Team invitation"
    # row) and mirror the target org/team locally as remote=True — no
    # conversation / preview FlowMessage is involved.
    target = hub_inv.get("target")
    if isinstance(target, dict) and target.get("type") and target.get("id"):
        return await _materialize_membership_invitation(hub_inv, target, someone_typeid), None

    existing_inv = await LocalInvitation.get_one({"id": inv_id})
    # Persist the invitation→conversation linkage. The hub stamps
    # ``target_url_path`` null but embeds the target ``conversation``; without
    # writing the linkage here the local Invitation row is unmatchable to its
    # conversation (receivers polling "the invitation for conv X" can only
    # guess by recency, which breaks the moment stale invitations exist).
    from flow_sdk.builtin.invitation import conversation_target_path  # noqa: PLC0415

    _embedded = hub_inv.get("conversation")
    _target_path = hub_inv.get("target_url_path") or (
        conversation_target_path(_embedded["id"])
        if isinstance(_embedded, dict) and _embedded.get("id")
        else None
    )
    inv_fields = {
        "id": inv_id,
        "recipient_email": hub_inv.get("recipient_email") or "",
        "accepted": bool(hub_inv.get("accepted") or False),
        "sent": bool(hub_inv.get("sent") or False),
        "message": hub_inv.get("message"),
        "target_url_path": _target_path,
        "remote": True,
    }
    if existing_inv:
        existing_inv.recipient_email = inv_fields["recipient_email"]
        existing_inv.accepted = inv_fields["accepted"]
        existing_inv.sent = inv_fields["sent"]
        existing_inv.message = inv_fields["message"]
        if _target_path:
            existing_inv.target_url_path = _target_path
        existing_inv.remote = True
        local_inv = await existing_inv.save(someone_typeid)
    else:
        local_inv = await LocalInvitation.model_validate(inv_fields).save(someone_typeid)

    if local_inv.accepted:
        return local_inv, None

    # Materialize the embedded Conversation if the hub provided one.
    embedded_conv = hub_inv.get("conversation")
    if not isinstance(embedded_conv, dict) or not embedded_conv.get("id"):
        return local_inv, None
    conv_id = embedded_conv["id"]
    try:
        # notify=False — the conversation must NOT reach the UI until its
        # kind='invitation' first message exists. The explicit CREATE ops at
        # the end of this function announce a fully-formed row instead.
        await _upsert_hub_conversation_metadata(embedded_conv, someone_typeid, notify=False)
    except Exception as e:  # noqa: BLE001
        logger.warning("[inv-materialize] conv upsert failed: %s", e)
        return local_inv, None

    # Ensure the on-disk jsonl exists so future bundle writes have a home.
    try:
        rec = from_jsonl(
            default_jsonl_path(conv_id),
            parent_id="", record_id=conv_id, parent_type=RecordType.PROJECT,
        )
        rec.save()
    except Exception as e:  # noqa: BLE001
        logger.warning("[inv-materialize] jsonl init failed: %s", e)

    # Materialize the embedded preview FlowMessage. The UI keys off
    # ``kind='invitation'`` to render the invitation row, and reads the
    # Invitation TypeId out of ``shared_context_entities`` for the Accept
    # button. notify=False here too — the explicit CREATE ops below
    # announce the FlowMessage and Conversation together, in load-bearing
    # order, only once the conversation already carries its
    # invitation-kind first message. Without this the strip/inbox briefly
    # render a navigable row.
    preview = hub_inv.get("preview_message")
    invitation_typeid = f"{LocalInvitation.get_type()}-{inv_id}"
    inv_fm = None
    if isinstance(preview, dict):
        msg_payload = dict(preview)
        msg_payload.setdefault("text", local_inv.message or "You've been invited to a conversation")
        msg_payload["kind"] = FlowMessageKind.INVITATION.value
        # Accept either the new or legacy field name on the incoming hub
        # preview, then normalize on the new name for the local write.
        existing_ctx = (
            msg_payload.pop("shared_context_entities", None)
            or msg_payload.pop("context_entities", None)
            or []
        )
        if invitation_typeid not in existing_ctx:
            existing_ctx = list(existing_ctx) + [invitation_typeid]
        msg_payload["shared_context_entities"] = existing_ctx
        msg_payload["remote"] = True
        try:
            inv_fm = await materialize_flow_message(
                msg_payload,
                conversation_id=conv_id,
                someone_typeid=someone_typeid,
                notify=False,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[inv-materialize] preview msg failed: %s", e)
    else:
        # No real ``preview_message`` embedded by the hub (sender hasn't sent
        # an actual message yet, or this is a re-poll of the same invite).
        # Synthesize an invitation-kind FM so the UI's invitation-row branch
        # matches. The text is ``local_inv.message`` (the inviter's note)
        # when present, falling back to a generic placeholder otherwise.
        #
        # The id is derived deterministically from the invitation id so that
        # when ``_materialize_invitation`` re-runs (the WS nudge and the
        # ``pending`` poll both fire it for the same invite),
        # ``materialize_flow_message`` upserts the same row instead of
        # minting a fresh duplicate each time.
        import uuid as _uuid  # noqa: PLC0415
        synth_fm_id = str(_uuid.uuid5(_uuid.NAMESPACE_OID, f"invitation-preview-{inv_id}"))
        message_text = (local_inv.message or "").strip()
        synth_payload = {
            "id": synth_fm_id,
            "text": (message_text or "You've been invited to a conversation"),
            "kind": FlowMessageKind.INVITATION.value,
            "shared_context_entities": [invitation_typeid],
            "remote": False,
            # No fabricated identity: the hub sent no inviter for this notice, so
            # created_by / sender_id / sender_name stay NULL — the UI honestly
            # shows "unknown" rather than a pretend-valid sender. The
            # remote-reflection block below stops the driver stamping the local
            # recipient (who did NOT author the invite). The real inviter must
            # come from the hub (a preview_message), not be guessed here.
        }
        try:
            with remote_reflection():
                inv_fm = await materialize_flow_message(
                    synth_payload,
                    conversation_id=conv_id,
                    someone_typeid=someone_typeid,
                    notify=False,
                )
        except Exception as e:  # noqa: BLE001
            logger.warning("[inv-materialize] synth preview failed: %s", e)

    # Announce to the UI in load-bearing order — FlowMessage CREATE first so
    # the bubble row exists, then the Conversation CREATE. The conversation
    # now already carries its kind='invitation' pointer, so the strip/inbox
    # render it as a gated invitation row on the very first paint (no
    # navigable window before the Accept gate appears).
    try:
        from flow_sdk.api.messages import DataOpMessage, OperationType  # noqa: PLC0415
        from flow_sdk.core.network.resource_tracker import handle_entity_op  # noqa: PLC0415

        if inv_fm is not None:
            await handle_entity_op(
                DataOpMessage(data=inv_fm, op=OperationType.CREATE, to_entity=inv_fm.typeid)
            )
        conv_fresh = await Conversation.get_one({"id": conv_id})
        if conv_fresh is not None:
            await handle_entity_op(
                DataOpMessage(data=conv_fresh, op=OperationType.CREATE, to_entity=conv_fresh.typeid)
            )
    except Exception as e:  # noqa: BLE001
        logger.warning("[inv-materialize] invitation announce failed: %s", e)

    return local_inv, conv_id


# ---------------------------------------------------------------------------
# Unified conversation-list pipeline
#
# Single endpoint replacing the prior `conversation-sync` + `inbox-fetch` split.
# Reads local SQLite first (instant), pulls hub conversations + invitations in
# parallel, upserts hub metadata locally, and fans out per-conversation
# background message fetches keyed off the `message_count` delta. The hub WS
# bridge stays in place as the realtime channel; this path is the defensive
# catch-up that runs on Refresh / cold-start.
# ---------------------------------------------------------------------------

# Process-local single-flight registry for per-conversation message fetches.
# Keyed by conversation id. Prevents rapid Refresh clicks from piling up
# duplicate bundle downloads for the same conversation.
_conv_fetch_locks: dict[str, asyncio.Lock] = {}


# Max parallel hub message-fetches per catch-up batch. Firing every drifted
# conversation at once saturates the single event loop + the shared connection
# pool and is end-to-end SLOWER (measured ~3.5x: 227 convs took 7.8s unbounded
# vs 2.2s at 8) — classic concurrency thrash. A small pool flows smoothly.
_BG_FETCH_CONCURRENCY = 8


async def _drain_conversation_message_fetches(conv_ids: list[str], someone_typeid: str) -> None:
    """Catch up message state for many conversations, bounded concurrency.

    Runs as ONE detached task OFF the request path, so the list handler returns
    before any fetch starts (no event-loop contention with the foreground
    reconcile). Per-conv single-flight is preserved by the in-task lock.
    """
    sem = asyncio.Semaphore(_BG_FETCH_CONCURRENCY)

    async def _one(cid: str) -> None:
        existing = _conv_fetch_locks.get(cid)
        if existing is not None and existing.locked():
            return  # a fetch for this conv is already in flight
        async with sem:
            try:
                await _fetch_conversation_messages(cid, someone_typeid)
            except Exception as e:  # noqa: BLE001
                logger.warning("[conv-msg-drain] %s failed: %s", cid[:8], e)

    await asyncio.gather(*[_one(c) for c in conv_ids], return_exceptions=True)


def _dispatch_conversation_message_fetches(conv_ids: list[str], someone_typeid: str) -> None:
    """Fire-and-forget a whole catch-up batch as one detached, bounded drain.

    Deferred + bounded: the caller collects the drifted conv ids during its
    foreground work and dispatches them all here at the very end, so the fetches
    neither interleave with the reconcile loop nor flood the loop all at once.
    """
    if not conv_ids:
        return
    try:
        asyncio.create_task(
            _drain_conversation_message_fetches(conv_ids, someone_typeid),
            name=f"conv-msg-drain-{len(conv_ids)}",
        )
    except RuntimeError:
        # No running loop (e.g. a sync call context) — nothing to schedule.
        pass


# Hub-hosted child types pulled during the shared-context catch-up. Comments
# today; add other shareable is_child types here as they gain hub support.
_SHARED_CHILD_TYPES = (BuiltinEntityType.COMMENT.value,)


async def _materialize_remote_child(cls, data: dict, parent_ref: str, someone_typeid: str | None):
    """Upsert a hub child dict locally as a remote is_child of ``parent_ref``.

    Thin wrapper over ``Entity.upsert_from_hub_child`` (shared with the live
    bridge path). Returns the saved entity."""
    return await cls.upsert_from_hub_child(data, parent_ref, someone_typeid)


async def _sync_remote_children(parent_tid: TypeId, child_type: str, someone_typeid: str | None) -> None:
    """Pull ``parent_tid``'s hub children of ``child_type`` and materialize the
    new/changed ones locally (LWW via ``is_stale``). Best-effort."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    cls = SchemaRegistry.get_entity_cls(child_type)
    if cls is None:
        return
    # hub_get expects a BuiltinEntityType for the entity_type arg (it reads
    # ``.value``); parent_tid.type is a plain string, so coerce.
    try:
        parent_etype = BuiltinEntityType(parent_tid.type)
    except ValueError:
        parent_etype = parent_tid.type
    children = await hub_get(parent_etype, parent_tid.id, action=child_type)
    child_list: list[dict] = []
    if isinstance(children, list):
        child_list = children
    elif isinstance(children, dict):
        for k in ("data", "items", "results"):
            v = children.get(k)
            if isinstance(v, list):
                child_list = v
                break
    parent_ref = f"{parent_tid.type}-{parent_tid.id}"
    for raw in child_list:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue
        local = await cls.get_one({"id": raw["id"]})
        if local is not None and not cls.is_stale(local, raw):
            continue
        try:
            await _materialize_remote_child(cls, raw, parent_ref, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[subtree-sync] materialize %s-%s failed (non-fatal): %s", child_type, raw.get("id"), e)


async def _sync_shared_context_subtree(conv_id: str, someone_typeid: str | None) -> None:
    """Recursive-share catch-up for one conversation.

    For each ``shared_context_entities`` member (e.g. the shared markdown):
      1. Link the locally-materialized ones to this conversation (parent_type_id)
         so effective-remote resolves and comments auto-share.
      2. Pull its child comments from the hub as remote children.

    NO stub minting here: shared-context rows are materialized exclusively by
    the bundle download → unpack pipeline (``_process_single_hub_message`` /
    ``_download_and_unpack_bundle``), which carries the real entity data. A
    placeholder row minted ahead of the bundle used to permanently block the
    unpack's exists-check from landing the real fields. Refs whose bundle
    hasn't arrived yet are simply skipped by the linker and picked up on the
    next sync pass — order no longer decides the outcome.

    This is what lets a recipient who never watched the doc live still see the
    doc + everyone's comments after a sync. Best-effort; never raises."""
    try:
        conv = await Conversation.get_one({"id": conv_id})
        if conv is None or not conv.shared_context_entities:
            return  # nothing shared → no subtree to catch up (skip the hub GET)
        # 1) Link each locally-present shared-context doc to this conversation
        #    so its ``effective_remote`` resolves (the doc is NOT a hub entity —
        #    the hub has no markdown type — its content arrives via the bundle
        #    unpack). Reuses the same linker the share path runs; missing rows
        #    are skipped (bundle not downloaded yet).
        await conv._link_context_to_conversation()
        # 2) Pull the conversation's hub child entities (comments today; each
        #    carries its real doc parent in ``parent_type_id``). Materialize
        #    new/changed ones locally.
        conv_tid = TypeId(f"{BuiltinEntityType.CONVERSATION.value}-{conv_id}")
        for child_type in _SHARED_CHILD_TYPES:
            await _sync_remote_children(conv_tid, child_type, someone_typeid)
    except Exception as e:  # noqa: BLE001
        logger.warning("[subtree-sync] conv=%s failed (non-fatal): %s", conv_id, e)


async def _fetch_conversation_messages(conv_id: str, someone_typeid: str) -> None:
    """Bring local message state for a single conversation up to the hub's.

    Lists the conversation's child FlowMessages via the children-list route
    ``/conversation/<id>/flow_message`` in ONE request — each child carries its
    ``updated_date``, so we diff **new ∪ changed** (not new-only): every child
    is routed through ``_process_single_hub_message``, which applies the LWW
    invalidation rule (``Entity.is_stale``) and is a no-op for rows already
    current. A conversation whose messages are all unchanged does zero writes
    and zero per-message GETs.

    Replaces the prior approach (read the ``message_ids`` pointer projection,
    diff new-only, then one ``hub_get(FLOW_MESSAGE, id)`` per missing id) — that
    missed edits and fanned out N requests. The children route returns the full
    FM dicts, so the per-id GET loop is gone.

    All exceptions are logged and swallowed — this runs as a detached task and
    must never crash the event loop.
    """
    lock = _conv_fetch_locks.setdefault(conv_id, asyncio.Lock())
    async with lock:
        try:
            # Children-list route, primary source: returns the conversation's
            # FlowMessage children (with updated_date) the caller may see.
            # hub_get's url builder requires an action segment before sub_path.
            children = await hub_get(
                BuiltinEntityType.CONVERSATION, conv_id, action="flow_message",
            )
            # hub_get returns the unwrapped `data` when 200 and None on any
            # failure. None ⇒ we cannot prove anything — abort without
            # touching local state. An EMPTY LIST is a real answer ("this
            # conversation has zero messages you may see") and still goes
            # through the authoritative reconcile below.
            if children is None:
                logger.warning("[conv-msg-fetch] %s: children listing unavailable, skipping", conv_id[:8])
                return
            child_list: list[dict] = []
            if isinstance(children, list):
                child_list = children
            elif isinstance(children, dict):
                for k in ("data", "items", "results"):
                    v = children.get(k)
                    if isinstance(v, list):
                        child_list = v
                        break
            child_list = [m for m in child_list if isinstance(m, dict) and m.get("id")]
            # Oldest first — the pointer index is conversation order.
            child_list.sort(key=lambda m: m.get("created_date") or "")
            synced = 0
            for raw_fm in child_list:
                fm_id = raw_fm["id"]
                # Cheap skip: already-current rows need no work (and no body
                # re-download). is_stale(None, ...) is True so new ids pass.
                local = await FlowMessage.get_one({"id": fm_id})
                if not FlowMessage.is_stale(local, raw_fm):
                    continue
                try:
                    # Hub's FM payload doesn't carry conversation_id (the graph
                    # edge is the source of truth on the hub). The local-side
                    # _process_single_hub_message + pointer-append flow needs it
                    # to know which conversation.jsonl to update. Inject it.
                    raw_fm.setdefault("conversation_id", conv_id)
                    await _process_single_hub_message(raw_fm)
                    synced += 1
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "[conv-msg-fetch] %s: fm=%s failed: %s",
                        conv_id[:8], fm_id, e,
                    )
            # Authoritative reconcile — the hub child list IS the message set.
            # Rewrite conversation.jsonl to exactly (hub children, in
            # created_date order) ∪ (local-pending not yet on the hub), then
            # re-project unconditionally (no-op when already in sync). One
            # mechanism covers: offline deletes (local pointer absent on hub →
            # dropped), bare rows after a DB rebuild (projection rebuilt from
            # the merged set), and orphan entities (pointer lost from the file
            # → restored from the hub list).
            try:
                rec = from_jsonl(
                    default_jsonl_path(conv_id),
                    parent_id="", record_id=conv_id, parent_type=RecordType.PROJECT,
                )
                hub_ids = {m["id"] for m in child_list}
                merged: list[Pointer] = [
                    Pointer(
                        TypeId(type=Pointer.DEFAULT_MESSAGE_TYPE, id=m["id"]),
                        str(m.get("created_date") or "") or datetime.now(UTC).isoformat(),
                    )
                    for m in child_list
                ]
                dropped = 0
                for ptr in message_pointers(rec):
                    if ptr.id in hub_ids:
                        continue  # hub-confirmed; already in merged
                    # Local-pending: provably local-born rows the hub can't
                    # know about yet — pre-accept (CREATED), invitation
                    # placeholders, drafts, or any row without a confirmed
                    # hub twin (remote=False). Fail-closed: a pointer whose
                    # FM row can't be loaded is KEPT, never dropped on
                    # uncertainty.
                    try:
                        fm = await FlowMessage.get_one({"id": ptr.id})
                    except Exception:  # noqa: BLE001
                        fm = None
                    keep = (
                        fm is None
                        or fm.delivery_status == DeliveryStatus.CREATED.value
                        or fm.kind == FlowMessageKind.INVITATION
                        or bool(getattr(fm, "is_draft", False))
                        or not fm.remote
                    )
                    if keep:
                        merged.append(ptr)
                    else:
                        # remote=True and absent from the hub list ⇒ deleted
                        # hub-side (or access revoked) — drop the stale copy.
                        dropped += 1
                write_pointers(rec, merged)
                await project_pointers_to_entity(rec, notify=True)
                if dropped:
                    logger.info(
                        "[conv-msg-fetch] %s: reconcile dropped %d hub-deleted pointer(s)",
                        conv_id[:8], dropped,
                    )
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "[conv-msg-fetch] %s: authoritative reconcile failed: %s",
                    conv_id[:8], e,
                )
            logger.info(
                "[conv-msg-fetch] %s: synced %d of %d hub message(s)",
                conv_id[:8], synced, len(child_list),
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("[conv-msg-fetch] %s: aborted: %s", conv_id[:8], e)


async def _ensure_local_conversation_synced(conv_id: str, someone_typeid: str) -> None:
    """Make sure the local DB has the conv + its messages.

    Idempotent. Used by deep-link handlers (``handle_open_flow_message``) for
    flows where the FM ships without a body bundle (e.g. text-only first
    message from a fresh share) and the recipient would otherwise see a
    placeholder or an empty conv.
    """
    from flow_sdk.builtin.conversation import Conversation as LocalConversation  # noqa: PLC0415

    # Join the hub-side conv so we enter ``participants`` and start
    # receiving WS fanout. Idempotent — already-a-member is a no-op.
    try:
        await hub_post(BuiltinEntityType.CONVERSATION, {}, conv_id, "join")
    except Exception as e:
        logger.debug("[conv-sync] join %s: %s", conv_id[:8], e)

    # Materialize the local row from the hub if it's missing.
    existing = await LocalConversation.get_one({"id": conv_id})
    if existing is None:
        try:
            hub_conv = await hub_get(BuiltinEntityType.CONVERSATION, conv_id)
            if isinstance(hub_conv, dict) and hub_conv.get("id"):
                await LocalConversation.model_validate({
                    "id": conv_id,
                    "title": hub_conv.get("title"),
                    "remote": True,
                }).save(someone_typeid)
        except Exception as e:
            logger.debug("[conv-sync] materialize %s: %s", conv_id[:8], e)

    # Pull any messages the WS bridge didn't fan out (everything from before
    # the join in particular).
    await _sync_conversation_messages(conv_id, someone_typeid)


async def _sync_conversation_messages(conv_id: str, someone_typeid: str) -> None:
    """Materialize every hub-side message of a conversation into the local store.

    Uses the standard scoped query ``GET /graph/conversation/<id>/flow_message``
    — the hub returns the conversation's child FlowMessages the caller is
    authorized to see (the dual role-path auth is satisfied once the caller
    has joined the conversation). Each FM is materialized via
    ``materialize_flow_message``, which is idempotent, so messages already
    delivered through the WS bridge are no-ops.

    Called after an invitation accept: the hub WS only fanouts messages from
    join-time forward, so the inviter's pre-accept messages (notably the
    first one) need this explicit pull. After materializing each FM's row,
    if the hub payload advertises a body bundle (``attachment_filename``)
    the bundle is pulled and unpacked here so embedded TYPE_ID attachments
    (Task / Spec / etc.) materialize on the recipient — without this step
    the recipient would see only the FM text and miss any shared entities
    the sender attached.
    """
    from flow_sdk.app.actions.materialize_flow_message import (  # noqa: PLC0415
        materialize_flow_message,
    )

    hub_msgs = await hub_get(
        BuiltinEntityType.FLOW_MESSAGE,
        scope=[("conversation", conv_id)],
    )
    ordered = sorted(
        (m for m in (hub_msgs or []) if isinstance(m, dict) and m.get("id")),
        key=lambda m: m.get("created_date") or "",
    )
    logger.info("[conv-sync] conv=%s: syncing %d message(s)", conv_id[:8], len(ordered))
    for raw_fm in ordered:
        try:
            await materialize_flow_message(
                raw_fm,
                conversation_id=conv_id,
                someone_typeid=someone_typeid,
                notify=True,
                remote=True,
            )
        except Exception as fm_err:  # noqa: BLE001
            logger.warning(
                "[conv-sync] conv=%s fm=%s materialize failed: %s",
                conv_id[:8], raw_fm.get("id"), fm_err,
            )
            continue
        attachment_filename = (raw_fm.get("attachment_filename") or "").strip()
        if not attachment_filename:
            continue
        try:
            await _download_and_unpack_bundle(
                raw_fm["id"], attachment_filename, body_status=raw_fm.get("body_status"),
            )
        except Exception as b_err:  # noqa: BLE001
            logger.warning(
                "[conv-sync] conv=%s fm=%s bundle download failed: %s",
                conv_id[:8], raw_fm.get("id"), b_err,
            )


_UNSET = object()  # sentinel: distinguishes "existing not provided" from "known absent (None)"


async def _upsert_hub_conversation_metadata(
    hub_conv: dict, someone_typeid: str, *, notify: bool = True, existing=_UNSET,
) -> Optional[Conversation]:
    """Upsert a hub-side Conversation into the local SQLite table.

    ``existing`` lets a caller that already holds the local row (e.g. the
    conversation-list bulk-read cache) pass it in to skip the per-row
    ``get_one``. Pass ``None`` for "known absent" (→ create path); omit it
    entirely to have this function load the row itself.

    Copies the user-visible metadata (``title``, ``participants``,
    ``remote_project_id`` / ``remote_project_name``, ``message_status_visible``)
    onto the local row and marks ``remote=True``. **Does not touch**
    ``message_ids`` / ``message_count`` — those are projection-guarded on the
    local side and only legitimately written by
    ``ConversationRecord._project_pointers_to_entity`` as bundles are unpacked.

    ``notify=False`` saves the row without broadcasting the entity op — used
    by the invitation pipeline, which must materialize the conversation's
    ``kind='invitation'`` first message *before* the UI ever sees the
    conversation (otherwise the strip/inbox briefly render it as a normal,
    navigable row). The caller emits the CREATE op itself once the row is
    fully formed.
    """
    conv_id = (hub_conv.get("id") or "").strip()
    if not conv_id:
        return None
    # Defensive: if the hub signals this conv was deleted (audit-only on
    # hub-side after owner-delete), we still expect the prune step to clear
    # the local row. Short-circuit here so we don't re-create it.
    if hub_conv.get("deleted_at"):
        existing = await Conversation.get_one({"id": conv_id})
        if existing is not None:
            try:
                await _hard_delete_local_conversation(existing)
            except Exception as e:  # noqa: BLE001
                logger.warning("[conv-upsert] deleted_at hub row, local cleanup failed: %s", e)
        return None
    if existing is _UNSET:
        existing = await Conversation.get_one({"id": conv_id})
    if existing is None:
        payload: dict = {"id": conv_id, "remote": True}
        for k in ("title", "participants", "remote_project_id", "remote_project_name",
                  "shared_context_entities"):
            if hub_conv.get(k) is not None:
                payload[k] = (
                    _normalize_participants(hub_conv[k])
                    if k == "participants" and isinstance(hub_conv[k], list)
                    else hub_conv[k]
                )
        # Hub owner field ``initiated_by`` mirrors locally as ``created_by``,
        # carried VERBATIM — including ``None`` (share-created conversations
        # carry no owner). The receiver must NOT fabricate a 'system' sentinel
        # nor let the driver stamp the local user; the remote-reflection block
        # around the save guarantees both. A null owner resolves for display via
        # the participant roster's ``owner`` role.
        if hub_conv.get("initiated_by") is not None:
            payload["created_by"] = hub_conv["initiated_by"]
        if hub_conv.get("message_status_visible") is not None:
            payload["message_status_visible"] = bool(hub_conv["message_status_visible"])
        # Carry the hub's updated_date so the local row records the hub
        # timestamp — the LWW decision point that lets conversation-list detect
        # "this conversation changed" by comparing parent updated_date alone,
        # without listing messages (Entity.is_stale). The driver preserves a
        # non-None updated_date on save.
        if hub_conv.get("updated_date") is not None:
            payload["updated_date"] = hub_conv["updated_date"]
        # The hub is the source of truth for when the conversation was born —
        # without this, a locally re-created row (e.g. after a DB rebuild)
        # claims its re-creation moment as the creation date. The driver
        # preserves a preset created_date on save.
        if hub_conv.get("created_date") is not None:
            payload["created_date"] = hub_conv["created_date"]
        payload["fetched_at"] = datetime.now(UTC)
        # Deterministically adopt the local owning project from the shared/target
        # entity (same rule as local create / receive). The hub never carries a
        # local ``project_id`` — only ``remote_project_id`` (the sender's). When a
        # shared entity resolves to a local project, stamp it so the conversation
        # lands in that project without the receiver "map a project" prompt; an
        # entity-less remote chat stays project-less (None) by design.
        derived_project_id = await Conversation.resolve_project_id(
            payload.get("shared_context_entities")
        )
        if derived_project_id:
            payload["project_id"] = derived_project_id
        conv = Conversation.model_validate(payload)
        conv.id = conv_id
        # Pure reflection of the hub row: preserve created_by/updated_by/dates
        # verbatim, never the local sync user.
        with remote_reflection():
            return await conv.save(someone_typeid, notify=notify)
    # Update path: copy hub-owned fields without touching projections.
    changed = False
    for k in ("title", "participants", "remote_project_id", "remote_project_name"):
        v = hub_conv.get(k)
        if k == "participants" and isinstance(v, list):
            v = _normalize_participants(v)
        if v is not None and getattr(existing, k, None) != v:
            setattr(existing, k, v)
            changed = True
    # ``shared_context_entities`` is wire-bound (hub-authoritative): adopt the
    # hub's list when it differs. Local is list[TypeId], hub returns list[str] —
    # compare via string projection so a re-echo of the same set is a no-op.
    hub_ctx = hub_conv.get("shared_context_entities")
    if isinstance(hub_ctx, list):
        local_ctx = [str(t) for t in (existing.shared_context_entities or [])]
        if local_ctx != [str(c) for c in hub_ctx]:
            existing.shared_context_entities = hub_ctx
            changed = True
    hub_owner = hub_conv.get("initiated_by")
    if hub_owner is not None and getattr(existing, "created_by", None) != hub_owner:
        existing.created_by = hub_owner
        changed = True
    if hub_conv.get("message_status_visible") is not None and \
            existing.message_status_visible != bool(hub_conv["message_status_visible"]):
        existing.message_status_visible = bool(hub_conv["message_status_visible"])
        changed = True
    if not existing.remote:
        existing.remote = True
        changed = True
    # Always-adopt the hub's created_date (hub-authoritative birth time). This
    # is idempotent — once converged, subsequent echoes are no-ops — and it
    # repairs rows that were re-created locally with a bogus created_date
    # (e.g. after a DB rebuild).
    hub_created = Conversation._as_datetime(hub_conv.get("created_date"))
    if hub_created is not None and Conversation._as_datetime(existing.created_date) != hub_created:
        existing.created_date = hub_created
        changed = True
    # Deliberately NOT adopting the hub parent ``updated_date``: the hub re-stamps
    # it on bare touches (a child's body re-download), which would surface a
    # days-old conversation as "just now". Recency is owned by
    # ``project_pointers_to_entity`` (derived from messages' real-change clocks).
    # ``_should_fetch_messages`` still consults the hub clock transiently to gate
    # the reconcile; it's just never persisted as local recency.
    if changed:
        # We just refreshed this row from a hub payload — stamp the boundary.
        existing.fetched_at = datetime.now(UTC)
        # Reflection: don't let apply_update_fields clobber updated_by with the
        # local sync user — the hub's updated_date/owner are authoritative here.
        with remote_reflection():
            return await existing.save(someone_typeid, notify=notify)
    return existing


def _should_fetch_messages(local_conv: Optional[Conversation], hub_conv: dict) -> bool:
    """Out-of-sync detection for one conversation — the dispatch gate of the
    list pipeline. Two independent signals, OR-ed (the hub is the source of
    truth; either one firing invalidates the local copy via the authoritative
    reconcile in ``_fetch_conversation_messages``):

    - ``updated_date`` LWW (``Entity.is_stale``): the hub bumps the parent on
      child add/edit/delete AND on delivery/body status changes, so one cheap
      parent compare catches every content/status change.
    - ``message_count`` mismatch, BIDIRECTIONAL: catches drift the date can't
      prove — e.g. a local row re-created bare from the hub (carries the hub's
      updated_date, so is_stale says current, but reports 0 messages), or a
      stale local extra after a missed delete.

    Hub count ``None`` (old hub / pre-field row) ⇒ unknown. Date-only then,
    EXCEPT when the local projection is empty: an empty cache we cannot
    verify cheaply is exactly the bare-row incident shape, so dispatch the
    (single-flight, cheap) fetch and let the authoritative reconcile settle
    it. A genuinely empty conversation just reconciles to empty again; once
    the hub ships counts this branch never fires.
    """
    if local_conv is None:
        return True
    if Conversation.is_stale(local_conv, hub_conv):
        return True
    raw_hub_count = hub_conv.get("message_count")
    if raw_hub_count is None:
        return not local_conv.message_ids
    local_count = int(local_conv.message_count or 0)
    return int(raw_hub_count) != local_count


async def _local_only_conversation_list(*, auth_required: bool, user_id: str | None = None) -> ApiSuccessResponse:
    """Local-only conversation-list response: render whatever's in SQLite and
    flag the hub unreachable. Used when the hub isn't configured
    (``auth_required=False``) or there's no cloud session (``auth_required=True``).

    If user_id is provided, only conversations created by that user are returned."""
    filter_dict = {"created_by": user_id} if user_id else {}
    local = await Conversation.get_all(filter_dict)
    return ApiSuccessResponse(data={
        "conversations": [c.model_dump(mode="json") for c in local],
        "bg_fetch_dispatched": [],
        "hub_reachable": False,
        "auth_required": auth_required,
    })


async def handle_conversation_list(someone_typeid) -> ApiResponse:
    """Unified conversation list: local SQLite + hub catch-up + background message fetch.

    Pipeline (all stages run inside the request handler unless noted):

    1. Read local conversations from SQLite (the canonical render source).
    2. In parallel, hub_get(CONVERSATION) + hub_get(INVITATION, pending).
       Failures here are non-fatal — we degrade to local-only with a flag.
    3. For each hub conversation, upsert metadata locally (title, participants,
       updated_date, etc.). If the hub's parent ``updated_date`` is newer than
       the local copy's (bumped on add OR edit of any child message), queue a
       single-flight background message sync.
    4. For each pending invitation, run the existing
       ``_materialize_remote_invitation`` + placeholder-conversation pipeline.
    5. Return the freshly-merged local list. Background fetches run after the
       HTTP response is sent; their results stream in via WS data_op_msg.
    """
    # Extract user ID from someone_typeid (could be TypeId object or string)
    user_id = someone_typeid.id if hasattr(someone_typeid, 'id') else str(someone_typeid).split('-', 1)[-1]
    logger.info(f"[conversation-list] Filtering for user_id: {user_id}")

    if not hub_base_url():
        # Local-only mode: still return whatever's in SQLite so the UI renders.
        return await _local_only_conversation_list(auth_required=False, user_id=user_id)

    # Logged out → every hub conversation/invitation call would 401 and surface
    # a "Cloud Request Failed" warning (and feed the hub-error suppression
    # window). Return local-only with auth_required, exactly like
    # _start_inbox_catchup skips the same calls at startup.
    from flow_sdk.cli.auth.hub_login import hub_auth_available  # noqa: PLC0415
    if not hub_auth_available():
        return await _local_only_conversation_list(auth_required=True, user_id=user_id)

    # Bulk-read the entire local mirror ONCE as the reconcile cache. This is the
    # only consumer of ``local_index`` — the returned list is the separate,
    # unfiltered ``merged`` below, so output is unaffected. (Must NOT filter by
    # ``created_by``: remote conversations carry the hub owner's id, not the local
    # user's, so a ``created_by`` filter returns nothing — emptying the cache and
    # forcing a per-row get_one + a spurious "stale" verdict for every conv.)
    local_list = await Conversation.get_all({})
    local_index = {c.id: c for c in local_list if c.id}

    hub_convs_result, hub_invs_result = await asyncio.gather(
        hub_get(BuiltinEntityType.CONVERSATION),
        hub_get(BuiltinEntityType.INVITATION, action="pending"),
        return_exceptions=True,
    )

    hub_reachable = True
    auth_required = False

    def _coerce_list(result) -> Optional[list]:
        nonlocal hub_reachable, auth_required
        if isinstance(result, Exception):
            hub_reachable = False
            if "401" in str(result) or "Unauthorized" in str(result):
                auth_required = True
            return None
        if result is None:
            hub_reachable = False
            return None
        return result if isinstance(result, list) else []

    hub_convs = _coerce_list(hub_convs_result) or []
    hub_invs = _coerce_list(hub_invs_result) or []

    # (c) Reconcile hub conversation metadata into the local mirror, and COLLECT
    # the conversations whose messages have drifted (dispatched as one bounded
    # batch AFTER the response is built — see step (f)).
    #
    # Upsert ONLY conversations that actually changed: a row that's already local,
    # already remote, and not hub-stale needs no write. The hub bumps the parent
    # ``updated_date`` on every conversation change (message add/edit/delete,
    # delivery/body status, membership), so ``is_stale`` is a complete change
    # signal — see _should_fetch_messages. Skipping the unchanged majority avoids
    # a per-row get_one + save for every conversation on every list call.
    bg_fetch_dispatched: list[str] = []
    for hub_conv in hub_convs:
        conv_id = (hub_conv.get("id") or "").strip()
        if not conv_id:
            continue
        # ``existing`` is the PRE-upsert local copy from the bulk cache — the
        # correct comparison baseline. Capture the fetch decision BEFORE the
        # upsert mutates ``existing.updated_date``.
        existing = local_index.get(conv_id)
        should_fetch = _should_fetch_messages(existing, hub_conv)
        # ``created_date`` is hub-authoritative and corruptible locally (a DB
        # rebuild re-stamps it) without ever moving ``updated_date`` — so it can't
        # ride is_stale. Compare it here against the cache (free, in-memory) so the
        # repair branch in _upsert still runs; converged rows match and skip.
        _hub_created = Conversation._as_datetime(hub_conv.get("created_date"))
        _created_drift = (
            existing is not None
            and _hub_created is not None
            and Conversation._as_datetime(existing.created_date) != _hub_created
        )
        if (existing is None or not existing.remote
                or Conversation.is_stale(existing, hub_conv) or _created_drift):
            try:
                await _upsert_hub_conversation_metadata(
                    hub_conv, someone_typeid, existing=existing,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning("[conv-list] upsert conv=%s failed: %s", conv_id[:8], e)
                continue
        if should_fetch:
            # Collect now; dispatch the whole batch off-path at the end so these
            # fetches don't steal event-loop time from the reconcile above.
            bg_fetch_dispatched.append(conv_id)

    # (d) invitations through the new materializer: the hub embeds the
    # target Conversation + first FlowMessage in each invitation, so the
    # local row is the real conv (remote=True) — no synthesized placeholder.
    invitation_conv_ids: set[str] = set()
    for inv in hub_invs:
        try:
            _local_inv, conv_id = await _materialize_invitation(inv, someone_typeid)
            if conv_id:
                invitation_conv_ids.add(conv_id)
        except Exception as e:  # noqa: BLE001
            logger.warning("[conv-list] invitation materialize failed: %s", e)

    # (e) Prune step (decision #1c): any local `remote=True` row that did
    # NOT appear in this fetch (neither in hub_convs nor as the target of
    # a pending invitation) means it was deleted hub-side (or the local
    # user lost access). Reconcile by hard-deleting locally so the next
    # render reflects reality.
    pruned_ids: list[str] = []
    if hub_reachable:
        seen_ids = {c.get("id") for c in hub_convs if c.get("id")}
        seen_ids.update(invitation_conv_ids)
        # Re-read local state because the upsert + invitation steps may have
        # added rows that didn't exist when we snapshotted earlier.
        refreshed_local = await Conversation.get_all({})
        for c in refreshed_local:
            if c.remote and c.id and c.id not in seen_ids:
                try:
                    await _hard_delete_local_conversation(c)
                    pruned_ids.append(c.id)
                except Exception as e:  # noqa: BLE001
                    logger.warning("[conv-list] prune %s failed: %s",
                                   (c.id or "?")[:8], e)

    # (f) return the freshly-merged list.
    merged = await Conversation.get_all({})
    response = ApiSuccessResponse(data={
        "conversations": [c.model_dump(mode="json") for c in merged],
        "bg_fetch_dispatched": bg_fetch_dispatched,
        "pruned_ids": pruned_ids,
        "hub_reachable": hub_reachable,
        "auth_required": auth_required,
    })

    # (g) ONLY NOW — after the entire foreground reconcile — kick off the message
    # catch-up for all drifted conversations as ONE bounded, detached batch. The
    # fetches start as the response is sent (never contending with the loop above)
    # and only a few run at once. Their writes heal through the authoritative
    # reconcile in _fetch_conversation_messages and stream in via WS data_op.
    _dispatch_conversation_message_fetches(bg_fetch_dispatched, someone_typeid)
    return response


@action.post(action_name="conversation-list", types=None)
async def conversation_list() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_conversation_list(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-list error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-summary", types=None)
async def conversation_summary() -> ApiResponse:
    """Plain-text summary of one conversation (header + one line per message).

    Thin wrapper over ``Conversation.summary()`` — no LLM, no hub calls. Same
    auth gate as ``conversation-message-sync``: require a local Conversation
    row for the id so an authenticated caller can't summarize an arbitrary id.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        if not conv_id:
            return ApiFailResponse(message="conversation_id required")
        conv = await Conversation.get_one({"id": conv_id})
        if conv is None:
            return ApiFailResponse(message="conversation not found", status_code=404)
        return ApiSuccessResponse(
            data={"conversation_id": conv_id, "summary": await conv.summary()}
        )
    except Exception as e:
        logger.error("[flow_message_action] conversation-summary error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_conversation_sync(someone_typeid: str) -> ApiResponse:
    """**Deprecated** — delegates to ``handle_conversation_list``.

    Kept for back-compat with external SDK callers; new code should call the
    ``conversation-list`` action directly. The legacy response shape
    ``{invitations, flow_messages}`` is reconstructed from the new payload.
    """
    resp = await handle_conversation_list(someone_typeid)
    if not isinstance(resp, ApiSuccessResponse):
        return resp
    data = resp.data or {}
    return ApiSuccessResponse(data={
        "invitations": 0,  # legacy shape; placeholder count
        "flow_messages": len(data.get("bg_fetch_dispatched", []) or []),
    })


async def handle_invitation_sync(someone_typeid: str) -> ApiResponse:
    """Pull pending invitations only — no inbox-fetch.

    Realtime callers (vitest ping-pong, mobile poll-then-accept) need to
    discover a fresh invitation quickly. ``conversation-sync`` also runs the
    cursor-based inbox-fetch, which retries 404'd bundle downloads from
    prior FlowMessages and adds seconds of latency. This variant skips
    that, returning the moment invitations are mirrored.
    """
    if not hub_base_url():
        return ApiFailResponse(message="Hub not configured")

    inv_count = 0
    invitations = await hub_get(BuiltinEntityType.INVITATION, action="pending") or []
    if not isinstance(invitations, list):
        invitations = []
    for inv in invitations:
        try:
            local_inv, _conv_id = await _materialize_invitation(inv, someone_typeid)
            if local_inv:
                inv_count += 1
        except Exception as e:
            logger.warning("[invitation-sync] upsert failed: %s", e)
    return ApiSuccessResponse(data={"invitations": inv_count})


@action.post(action_name="conversation-sync", types=None)
async def conversation_sync() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_conversation_sync(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] conversation-sync error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="conversation-message-sync", types=None)
async def conversation_message_sync() -> ApiResponse:
    """Targeted per-conversation message catch-up.

    The conversation view calls this on open to pull new/changed hub messages
    for ONE conversation, instead of running the global conversation-list
    pipeline. Awaits the optimized ``_fetch_conversation_messages``
    (children-list route in a single request + ``is_stale`` new∪changed diff),
    so by the time it returns the local live query already reflects the hub
    state — the UI doesn't need a per-message backfill loop.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        conv_id = (body.get("conversation_id") or "").strip()
        if not conv_id:
            return ApiFailResponse(message="conversation_id required")
        # Authorization: require a local Conversation row for this id. Without
        # this gate any authenticated caller could trigger a hub fetch + local
        # store write under any conv_id they happen to know.
        local_conv = await Conversation.get_one({"id": conv_id})
        if local_conv is None:
            return ApiFailResponse(message="conversation not found", status_code=404)
        await _fetch_conversation_messages(conv_id, request_info.someone_typeid)
        # Recursive-share catch-up: pull shared-context children (e.g. the
        # shared markdown) + their comments so a recipient sees the doc and
        # everyone's comments without a live subscription.
        await _sync_shared_context_subtree(conv_id, request_info.someone_typeid)
        return ApiSuccessResponse(data={"conversation_id": conv_id})
    except Exception as e:
        logger.error("[flow_message_action] conversation-message-sync error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.post(action_name="invitation-sync", types=None)
async def invitation_sync() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_invitation_sync(request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] invitation-sync error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


async def handle_invitation_accept(body: dict, someone_typeid: str) -> ApiResponse:
    """Accept a pending invitation on the hub and download just the unlocked bundle.

    Three steps, no broad inbox sync:
      1. POST hub ``/members/accept`` — grants reader role on the linked FlowMessage.
      2. Mark the local Invitation as accepted so the strip's pending block
         drops the row on its next refetch.
      3. Targeted bundle download for the just-unlocked FlowMessage. ``unpack_bundle``
         materializes the local Conversation + appends pointers to its
         ``conversation.jsonl``. The strip's local refetch then sees the new
         Conversation row.

    Catching up on other accessible FlowMessages is the strip "Refresh" button's
    job (``conversation-sync`` action) — running it here would redownload every
    accessible bundle and double the latency.
    """
    inv_id = (body.get("invitation_id") or "").strip()
    if not inv_id:
        return ApiFailResponse(message="invitation_id required")

    # Hub exposes accept as GET /api/v1/graph/members/accept?invitation-id=X.
    from flow_sdk.utils.hub import hub_base_url as _hub_base
    base = _hub_base()
    if not base:
        return ApiFailResponse(message="Hub not configured")

    accept_url = f"{base}/api/v1/graph/members/accept"
    linked_fm_id: Optional[str] = None
    linked_conv_id: Optional[str] = None
    try:
        from flow_sdk.cloud_client import ApiConfig, FlowpadClient

        async with FlowpadClient(ApiConfig.from_env()) as client:
            resp = await client.request(
                "GET",
                accept_url,
                params={"invitation-id": inv_id},
                timeout=10,
            )
        # Hub responses we treat as "accept succeeded, run local cleanup":
        #   200 — JSON success: ``data`` carries the chosen target typeid.
        #   302 — post-accept landing redirect: ``Location`` points at
        #         ``/flow_message/<id>`` or ``/conversation/<id>``. The hub
        #         became browser-friendly and redirects the user to the
        #         unlocked entity after a successful accept. Verified on
        #         2026-05-28 with a real invitation against app.flowpad.ai.
        #   409 — already accepted (recipient clicked the email link first).
        #         No usable body, but server-side state is what we want and
        #         local cleanup still has work to do (mark accepted, sync).
        #
        # A 302 from this endpoint ALWAYS means the hub bounced us to
        # ``/login.html`` because the request was unauthenticated — the
        # accept did NOT execute. Probed against app.flowpad.ai on
        # 2026-05-28: 302 → ``/login.html?target_path=...`` for both
        # missing and invalid Authorization headers. Earlier this code
        # accepted 302 as success and ran local cleanup, which wrote
        # ``accepted=True`` locally for an invitation the hub never
        # accepted — causing every downstream conversation-scoped call to
        # return 401 ("no valid access for role ['member']").
        if resp.status_code not in (200, 409):
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location") or resp.headers.get("Location") or ""
                low = location.lower()
                # A redirect to a login page IS the unauthenticated bounce
                # (e.g. app.flowpad.ai → /login.html). The accept did NOT run.
                if "login" in low:
                    return ApiFailResponse(
                        message=(
                            "Accept failed: hub redirected us to login (request was "
                            f"unauthenticated). location={location[:200]}"
                        ),
                    )
                # Otherwise this hub bounces a SUCCESSFUL accept to the target's
                # page — the role was granted. The target is either the
                # conversation (/conversation/<id>) or the landing FlowMessage
                # (/flow_message/<id>); both mean success. Extract the id and
                # fall through to the normal post-accept resolution (the
                # FlowMessage path resolves its parent conv below).
                def _id_after(seg: str) -> Optional[str]:
                    if seg in location:
                        return location.split(seg)[1].split("/")[0].split("?")[0].split("#")[0]
                    return None
                if _id_after("/conversation/"):
                    linked_conv_id = _id_after("/conversation/")
                elif _id_after("/flow_message/"):
                    linked_fm_id = _id_after("/flow_message/")
                else:
                    # A non-login redirect to any OTHER entity landing — e.g.
                    # ``/skill/<id>`` when the accepted invitation's chosen
                    # target is a shared ASSET rather than a conversation — is
                    # still a SUCCESSFUL accept: the hub granted the role. There
                    # is no conversation to join; fall through so the invitation
                    # is marked accepted and the asset target is mirrored
                    # locally (the membership-target branch below). Only a
                    # ``login`` bounce (handled above) means the accept failed.
                    logger.info(
                        "[invitation-accept] accept redirected to a non-conversation entity "
                        "landing (asset target): %s", location[:160]
                    )
            else:
                return ApiFailResponse(
                    message=f"Accept failed ({resp.status_code}): {resp.text[:200]}"
                )
        if resp.status_code == 409:
            logger.info("[invitation-accept] hub returned 409 (already accepted) — running local cleanup")
        # Resolve the chosen target's typeid. Three response shapes to handle:
        #  - 200 + JSON body — ``data`` carries the typeid (string or dict).
        #  - 302 + Location header — no JSON body; the entity id lives in the
        #    Location path (``/flow_message/<id>`` or ``/conversation/<id>``).
        #  - 409 — already accepted; sometimes ships no body. We try both
        #    shapes below and fall through if neither yields a target.
        try:
            target = None
            body_text = (resp.text or "").strip()
            if body_text.startswith("{") or body_text.startswith("["):
                target = (resp.json() or {}).get("data")
            fm_prefix = f"{BuiltinEntityType.FLOW_MESSAGE.value}-"
            conv_prefix = f"{BuiltinEntityType.CONVERSATION.value}-"
            if isinstance(target, str):
                if target.startswith(fm_prefix):
                    linked_fm_id = target[len(fm_prefix):]
                elif target.startswith(conv_prefix):
                    linked_conv_id = target[len(conv_prefix):]
            elif isinstance(target, dict):
                t_type = (target.get("type") or "").strip()
                t_id = (target.get("id") or target.get("identifier") or "").strip()
                if t_type == BuiltinEntityType.FLOW_MESSAGE.value and t_id:
                    linked_fm_id = t_id
                elif t_type == BuiltinEntityType.CONVERSATION.value and t_id:
                    linked_conv_id = t_id
            # 302 success: parse the Location header. Path shapes we expect:
            # ``/flow_message/<id>`` (FM landing) or ``/conversation/<id>``
            # (legacy/conv landing). Scan segments so a SUBPATH prefix
            # (e.g. ``/app/...``) doesn't break the match.
            if not linked_fm_id and not linked_conv_id:
                location = resp.headers.get("location") or resp.headers.get("Location") or ""
                if location:
                    from urllib.parse import urlparse  # noqa: PLC0415
                    path = urlparse(location).path or ""
                    parts = [p for p in path.split("/") if p]
                    for i, seg in enumerate(parts[:-1]):
                        if seg == BuiltinEntityType.FLOW_MESSAGE.value:
                            linked_fm_id = parts[i + 1]
                            break
                        if seg == BuiltinEntityType.CONVERSATION.value:
                            linked_conv_id = parts[i + 1]
                            break
            # When we only have the FlowMessage id, fetch its parent conv id
            # so the join + msg-sync path runs (same as the email-accept flow).
            # Hub FMs don't expose a top-level ``conversation_id`` field — the
            # parent conv lives as a typeid in ``shared_context_entities``.
            if linked_fm_id and not linked_conv_id:
                try:
                    fm_data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, linked_fm_id)
                    if isinstance(fm_data, dict):
                        # 1. Top-level field (older shape / direct mirror).
                        cid = (fm_data.get("conversation_id") or "").strip()
                        # 2. ``shared_context_entities`` (canonical shape).
                        if not cid:
                            conv_prefix_str = f"{BuiltinEntityType.CONVERSATION.value}-"
                            for raw in (fm_data.get("shared_context_entities") or []):
                                s = raw if isinstance(raw, str) else str(raw)
                                if s.startswith(conv_prefix_str):
                                    cid = s[len(conv_prefix_str):]
                                    break
                        if cid:
                            linked_conv_id = cid
                except Exception as fetch_err:
                    logger.debug("[invitation-accept] fm lookup for conv resolution failed: %s", fetch_err)
        except Exception as parse_err:
            logger.warning("[invitation-accept] could not parse target typeid: %s", parse_err)
    except Exception as e:
        return ApiFailResponse(message=f"Accept transport error: {e}")

    # Conversation target → join the hub-side conversation so we enter
    # ``participants`` and start receiving WS fanout. Then GET the conv from
    # the hub and save it locally so the UI's conversation view has something
    # to render the moment ``invitation-accept`` returns — without racing the
    # bridge's async ``_handle_conversation_op`` materialization.
    if linked_conv_id:
        try:
            from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
            from flow_sdk.cloud_client.client import ApiConfig, FlowpadClient  # noqa: PLC0415

            creds = load_credentials()
            if creds and creds.api_key:
                async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                    await client.post(f"/graph/conversation/{linked_conv_id}/join", {})
                    hub_conv = await client.get(f"/graph/conversation/{linked_conv_id}")
                if isinstance(hub_conv, dict) and hub_conv.get("id"):
                    participants = hub_conv.get("participants")
                    try:
                        async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                            members = await client.get(f"/graph/conversation/{linked_conv_id}/members")
                        if isinstance(members, dict):
                            for key in ("data", "members", "items", "results"):
                                if isinstance(members.get(key), list):
                                    members = members[key]
                                    break
                        if isinstance(members, list) and (members or not isinstance(participants, list)):
                            hub_conv = {**hub_conv, "participants": members}
                            participants = members
                    except Exception as roster_err:  # noqa: BLE001
                        logger.debug(
                            "[invitation-accept] members lookup failed for conv=%s: %s",
                            linked_conv_id[:8], roster_err,
                        )
                    if isinstance(participants, list):
                        await _learn_address_book(participants)
                    await _upsert_hub_conversation_metadata(hub_conv, someone_typeid)
                # Pull the inviter's pre-accept messages — the hub WS only
                # fanouts from join-time forward, so without this the first
                # message stays invisible until a manual refresh.
                await _sync_conversation_messages(linked_conv_id, someone_typeid)
        except Exception as e:
            logger.warning("[invitation-accept] hub join+materialize failed: %s", e, exc_info=True)

    # Mark local invitation as accepted (best-effort).
    membership_target: Optional["Invitation"] = None
    try:
        from flow_sdk.builtin.invitation import Invitation as LocalInvitation
        existing = await LocalInvitation.get_one({"id": inv_id})
        if existing:
            existing.accepted = True
            await existing.save(someone_typeid)
            if existing.target_type and existing.target_id:
                membership_target = existing
    except Exception as e:
        logger.warning("[invitation-accept] local update failed: %s", e)

    # Membership invitation (organization / team): the hub accept granted the
    # role — that IS the membership, no conversation/bundle to pull. Mirror the
    # target locally as remote=True so the Organization tab / member list shows
    # it immediately, and notify so the UI repaints.
    if membership_target is not None:
        try:
            cls = _membership_cls(membership_target.target_type)
            from flow_sdk.app.actions.membership_sync import (  # noqa: PLC0415
                materialize_remote_membership_entity,
            )
            ent = await materialize_remote_membership_entity(
                cls,
                {"id": membership_target.target_id, "name": membership_target.target_name},
                someone_typeid,
            )
            if ent is not None:
                await ent.notify_updated()
        except Exception as e:  # noqa: BLE001
            logger.warning("[invitation-accept] membership target materialize failed: %s", e)

    # The invitation now ships with the Conversation embedded, so the local
    # SDK already has the real conversation row pre-accept. Nothing to clean
    # up here — the invitation-kind FlowMessage stays as the first message
    # in the conversation (it IS the preview); subsequent bundle downloads
    # append after it.

    # Targeted bundle download — exactly one FM materialized (the one just
    # unlocked by the accept). Avoids the cursor-less inbox fetch that would
    # redownload every accessible bundle and add ~10s of latency.
    bundle_unpacked = False
    if linked_fm_id:
        try:
            hub_fm = await hub_get(BuiltinEntityType.FLOW_MESSAGE, linked_fm_id)
            attachment_filename = ((hub_fm or {}).get("attachment_filename") or "").strip()
            if attachment_filename:
                bundle_unpacked = await _download_and_unpack_bundle(
                    linked_fm_id, attachment_filename,
                    body_status=(hub_fm or {}).get("body_status"),
                )
        except Exception as e:
            logger.warning("[invitation-accept] bundle download failed: %s", e)

    # Live UI refresh: fire an explicit ``OperationType.UPDATE`` for the
    # Conversation entity. The per-step sniffer EVENTs logged above as
    # ``[hook_op] Unhandled event`` don't invalidate the UI's
    # ``useEntity<Conversation>`` React-Query cache. ``notify_updated``
    # dispatches a ``DataOpMessage(op=UPDATE)`` which IS what useEntity
    # listens for.
    # The per-step events fired above (materialize, sync) don't all carry the
    # final ``shared_context_entities`` value (bundle-unpack stamps task/spec
    # onto the conv last). Fire one explicit UPDATE on the now-settled
    # Conversation so subscribers see the final state in one shot.
    if linked_conv_id:
        try:
            from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
            conv_final = await Conversation.get_one({"id": linked_conv_id})
            if conv_final is not None:
                try:
                    await _learn_address_book(conv_final.participants or [])
                except Exception as learn_err:  # noqa: BLE001
                    logger.debug(
                        "[invitation-accept] final contact learn failed for conv=%s: %s",
                        linked_conv_id[:8], learn_err,
                    )
                await conv_final.notify_updated()
        except Exception as e:
            logger.debug("[invitation-accept] post-accept conv notify failed: %s", e)

    return ApiSuccessResponse(data={
        "invitation_id": inv_id,
        "flow_message_id": linked_fm_id,
        "conversation_id": linked_conv_id,
        "bundle_unpacked": bundle_unpacked,
    })


@action.post(action_name="invitation-accept", types=None)
async def invitation_accept() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        body = await request_info.get_post_data() or {}
        return await handle_invitation_accept(body, request_info.someone_typeid)
    except Exception as e:
        logger.error("[flow_message_action] invitation-accept error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


# ---------------------------------------------------------------------------
# Per-message Private Context actions
#
#   - `start-cc-from-transcript`: when the message has a `conversation.jsonl`
#     FILE attachment, spawn a Claude session pre-loaded with that transcript
#     path and ask for a brief analysis. The new AgenticProcess pins
#     `target_typeid_str = <fm typeid>` so the frontend query picks it up.
#
# The action returns immediately with `process_id`; the entity-query channel
# delivers updates to the UI as the run progresses.
# ---------------------------------------------------------------------------

async def _resolve_workdir_and_project_async(fm: FlowMessage) -> tuple[str, Optional[str]]:
    """Async variant — pulls task.project_root + project_id where available."""
    project_id: Optional[str] = None
    workdir = ""
    conv_id = fm.conversation_id
    if conv_id:
        conv = await Conversation.get_one({"id": conv_id})
        if conv:
            project_id = conv.project_id or project_id
            task_typeid = conv.first_context_of_type(BuiltinEntityType.TASK.value) if hasattr(conv, "first_context_of_type") else None
            if task_typeid:
                task = await Task.get_one({"id": task_typeid.id})
                if task:
                    project_id = task.project_id or project_id
                    workdir = (task.project_root or "").strip() or workdir
    if project_id and not workdir:
        from flow_sdk.builtin.project import Project
        project = await Project.get_one({"id": project_id})
        if project:
            workdir = (project.fs_storage_mount_path or "").strip() or workdir
    return workdir, project_id


async def handle_start_cc_from_transcript(fm_id: str, someone_typeid: str) -> ApiResponse:
    """Resolve transcript path + spawn info for a Claude session derived from this FM.

    Spawning the AgenticProcess is intentionally left to the frontend
    (mirrors `useMyProcess`'s pattern: ``AgenticProcess.spawn(..., { visible: true })``
    + ``process.start({ instruction })``) so we get a real PTY-backed shell
    the user can interact with — a backend-spawned ``visible=false`` worker
    has no PTY to attach to and the dock's shell route falls back when
    navigated to.
    """
    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}")

    transcript = None
    for att in (fm.attachment or []):
        if att.attachment_type == AttachmentType.FILE and att.data.endswith("conversation.jsonl"):
            transcript = att
            break
    if not transcript:
        return ApiFailResponse(message="No transcript attachment on this message")

    transcript_path = transcript.local_path or transcript.data
    workdir, project_id = await _resolve_workdir_and_project_async(fm)

    return ApiSuccessResponse(data={
        "transcript_path": transcript_path,
        "workdir": workdir,
        "project_id": project_id,
    })


@action.post(action_name="start-cc-from-transcript", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def start_cc_from_transcript() -> ApiResponse:
    """Headless: start a Claude session from this FM's transcript attachment."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_start_cc_from_transcript(
            fm_id=str(request_info.target_entity_typeid.id),
            someone_typeid=request_info.someone_typeid,
        )
    except Exception as e:
        logger.error("[flow_message_action] start-cc-from-transcript error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Start CC failed: {str(e)}")


# ---------------------------------------------------------------------------
# Approve & Execute draft persistence
#
# After the headless run completes, the new ``useApproveAndExecute`` hook calls
# this action to persist the assistant reply as a draft ``FlowMessage`` on the
# scoped conversation. Doing the construction server-side avoids the gap where
# ``new FlowMessage().save()`` on the frontend drops the ``text`` field during
# its first serialization, which the server then rejects.
#
# The wrap pattern ``Prompt response: "<text>"`` is the contract ``MessageBubble``
# uses to italicise the quoted middle — the user edits the draft and the
# pattern naturally breaks, falling through to plain rendering.
# ---------------------------------------------------------------------------

_PROMPT_RESPONSE_PREFIX = 'Prompt response: "'
_PROMPT_RESPONSE_SUFFIX = '"'


def _wrap_as_claude_quote(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f"{_PROMPT_RESPONSE_PREFIX}{escaped}{_PROMPT_RESPONSE_SUFFIX}"


@action.post(action_name="save-prompt-response-draft", types=[BuiltinEntityType.CONVERSATION.value])
async def save_prompt_response_draft() -> ApiResponse:
    """Persist ``text`` as a draft FlowMessage on this conversation.

    Body: ``{text: str}``. Returns ``{flow_message_id}`` of the saved draft.
    Used by the Approve & Execute frontend hook.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        conv_id = str(request_info.target_entity_typeid.id)
        body = await request_info.get_post_data() or {}
        text = (body.get("text") or "").strip()
        if not text:
            return ApiFailResponse(message="text is required")

        sender_id, sender_name = await User.local_sender_identity()
        fm = FlowMessage.model_validate({
            "text": _wrap_as_claude_quote(text),
            "attachment": [],
            "sender_id": sender_id,
            "sender_name": sender_name,
            "conversation_id": conv_id,
            "is_draft": True,
        })
        fm.id = FlowMessage.allocate_id(fm.model_dump())
        await fm.save(request_info.someone_typeid)
        return ApiSuccessResponse(data={"flow_message_id": fm.id})
    except Exception as e:
        logger.error("[flow_message_action] save-prompt-response-draft error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")
