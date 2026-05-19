"""HTTP actions for FlowMessage file transport.

  POST /api/v1/graph/flow-message-upload      — upload .flowmsg (multipart, global action)
  POST /api/v1/graph/flow-message-create      — create task+spec+conv+FlowMessage locally, no email/git
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
from typing import Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage, FlowMessageKind
from flow_sdk.builtin.spec import Spec
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_records.conversation_record import ConversationRecord
from flow_sdk.fs_records.flow_message_bundle import FlowMessageExistsError
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk._compat import UTC
from flow_sdk.utils.hub import hub_get, hub_post, hub_base_url

logger = logging.getLogger(__name__)


def _meaningful_name(title: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return name[:60] or "untitled"


def _participant_label(participant: dict) -> str:
    if not isinstance(participant, dict):
        return "unknown"
    return participant.get("name") or participant.get("email") or "unknown"


async def _learn_address_book(participants: list[dict]) -> None:
    for participant in participants or []:
        if not isinstance(participant, dict):
            continue
        email = participant.get("email")
        if not isinstance(email, str) or not email.strip():
            continue
        name = participant.get("name")
        name = name.strip() if isinstance(name, str) and name.strip() else None
        await User.get_or_create_by_email(email.strip(), name=name)


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

    task_id = next((c.id for c in fm.context_entities if c.type == BuiltinEntityType.TASK.value), None)
    conv_id = next((c.id for c in fm.context_entities if c.type == BuiltinEntityType.CONVERSATION.value), None)

    return ApiSuccessResponse(data={
        "message_id": fm.id,
        "task_id": task_id,
        "conversation_id": conv_id,
        "was_new_task": True,
    })


async def handle_create_task_bundle(
    spec_title: str,
    spec_content: str,
    task_title: str,
    someone_typeid: str,
    message: Optional[str] = None,
    team_space_id: Optional[str] = None,
    project_id: Optional[str] = None,
) -> ApiResponse:
    """Create Task + Spec + Conversation + FlowMessage locally (no git push, no email).

    Returns flow_message_id so the caller can immediately trigger a .flowmsg download.
    """
    sender_id, sender_name = await User.local_sender_identity()

    # 1. Create Spec
    spec = Spec.model_validate({
        "title": spec_title,
        "content": spec_content,
        "spec_type": "plan",
        "author_id": sender_id,
    })
    spec.id = Spec.allocate_id(spec.model_dump())
    spec = await spec.save(someone_typeid)

    # 2. Create Task
    task = Task.model_validate({
        "title": task_title,
        "shared_by_id": sender_id,
        "team_space_id": team_space_id or None,
        # spec_id consolidated into ``context_entities``.
        "context_entities": [f"spec-{spec.id}"],
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)

    # 3. Create Conversation entity + canonical jsonl + parent linkage.
    from flow_sdk.app.actions.materialize_flow_message import (
        ensure_conversation_entity,
        materialize_flow_message,
    )

    conv_id = Conversation.allocate_id({
        "project_id": project_id,
        "context_entities": [f"task-{task.id}"],
    })
    task_typeid = TypeId(type=BuiltinEntityType.TASK.value, id=task.id)
    conv = await ensure_conversation_entity(
        conv_id, parent_typeid=task_typeid,
        project_id=project_id, someone_typeid=someone_typeid,
    )
    await task.attach_child(conv)
    task.add_context_entity(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))
    task = await task.save(someone_typeid)

    # 4. Materialize the first FlowMessage through the unified write path.
    fm_id = FlowMessage.allocate_id({"text": message or f"Task: {task_title}"})
    attachments = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.SPEC.value, id=spec.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm_id))),
    ]
    fm = await materialize_flow_message(
        {
            "id": fm_id,
            "text": message or f"Task: {task_title}",
            "context_entities": [task_typeid, TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id)],
            "attachment": attachments,
            "sender_id": sender_id,
            "sender_name": sender_name,
        },
        conversation_id=conv.id,
        someone_typeid=someone_typeid,
    )

    return ApiSuccessResponse(data={
        "flow_message_id": fm.id,
        "task_id": task.id,
        "conversation_id": conv.id,
        "spec_id": spec.id,
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


@action.post(action_name="flow-message-create", types=None)
async def create_task_bundle() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        body = await request_info.get_post_data() or {}
        spec_title = (body.get("spec_title") or "").strip()
        if not spec_title:
            return ApiFailResponse(message="spec_title is required")

        return await handle_create_task_bundle(
            spec_title=spec_title,
            spec_content=(body.get("spec_content") or "").strip(),
            task_title=(body.get("task_title") or spec_title).strip(),
            someone_typeid=request_info.someone_typeid,
            message=(body.get("message") or "").strip() or None,
            team_space_id=(body.get("team_space_id") or "").strip() or None,
            project_id=(body.get("project_id") or "").strip() or None,
        )
    except Exception as e:
        logger.error(f"[flow_message_action] create-task-bundle error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to create task bundle: {str(e)}")


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
            await _download_and_unpack_bundle(fm_id, attachment_filename)
        except Exception as e:
            logger.warning("[open_flow_message] failed to materialize bundle (non-fatal): %s", e)

    # Resolve conversation_id / task_id from the now-local FlowMessage so the
    # UI can navigate directly. Falls back to hub context if the FM didn't
    # land locally (e.g. no attachment_filename).
    conversation_id = ""
    task_id = ""
    local_fm = await FlowMessage.get_one({"id": fm_id})
    if local_fm:
        for ctx in (local_fm.context_entities or []):
            t = getattr(ctx, "type", None)
            if t == BuiltinEntityType.CONVERSATION.value and not conversation_id:
                conversation_id = getattr(ctx, "id", "") or ""
            elif t == BuiltinEntityType.TASK.value and not task_id:
                task_id = getattr(ctx, "id", "") or ""
    else:
        # Fall back to the hub's context list (string typeids like
        # "conversation-<uuid>"). Format kept loose to tolerate variations.
        for raw in ((data or {}).get("context_entities") or []):
            s = raw if isinstance(raw, str) else str(raw)
            if s.startswith(f"{BuiltinEntityType.CONVERSATION.value}-") and not conversation_id:
                conversation_id = s.split("-", 1)[1]
            elif s.startswith(f"{BuiltinEntityType.TASK.value}-") and not task_id:
                task_id = s.split("-", 1)[1]
        # Older hub payloads: task_id sometimes lives in meta or top-level.
        if not task_id:
            task_id = (meta.get("task_id") or (data or {}).get("task_id") or "").strip()

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


async def handle_download_body(fm_id: str) -> ApiResponse:
    """Download + unpack this message's body bundle. Refuses (BodyNotReadyError)
    if body_status != READY — receivers must wait for the hub UPDATE fanout."""
    from flow_sdk.builtin.flow_message import BodyNotReadyError
    from flow_sdk.core.network.resource_tracker import make_flow_message_progress_emitter
    fm = await _load_fm_local_or_hub(fm_id)
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}", status_code=404)
    try:
        await fm.download_body(on_progress=make_flow_message_progress_emitter(fm_id, "download"))
    except BodyNotReadyError as e:
        return ApiFailResponse(message=str(e), status_code=409)
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
        return await handle_download_body(str(request_info.target_entity_typeid.id))
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
) -> ApiResponse:
    """Create a Conversation directly under a Project (no Task).

    Each participant entry is {email, name?}. Every email is upserted as a
    local User so the contact list grows automatically. `title` becomes the
    conversation's display name; when omitted, falls back to a participants
    summary.
    """
    from flow_sdk.builtin.project import Project

    project = await Project.get_one({"id": project_id})
    if not project:
        return ApiFailResponse(message=f"Project not found: {project_id}", status_code=404)

    resolved = list(participants or [])
    await _learn_address_book(resolved)

    derived_name = (title or "").strip() or (
        ", ".join(_participant_label(p) for p in resolved) or None
    )

    conv = Conversation.model_validate({
        "task_id": None,
        "project_id": project.id,
        "participants": resolved,
        # `title` is the user-set display title (NewConversationDialog).
        # `name` mirrors it for legacy consumers that still read `conv.name`.
        "title": (title or "").strip() or None,
        "name": derived_name,
    })
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(someone_typeid)
    await project.attach_child(conv)

    # Canonical jsonl path is auto-created under records-data root.
    jsonl_path = ConversationRecord.default_jsonl_path(conv.id)
    rec = ConversationRecord.from_jsonl(
        jsonl_path, project.id, conv.id, parent_type=RecordType.PROJECT
    )
    rec.save()
    rec.link_to_parent_record()

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
        jsonl_path = ConversationRecord.default_jsonl_path(cid)
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
    from flow_sdk.utils.hub import hub_post  # noqa: PLC0415
    await hub_post(
        BuiltinEntityType.INVITATION,
        {"invitation_id": invitation_id},
        action="decline",
    )


async def _hub_delete_conversation(conv_id: str) -> None:
    from flow_sdk.utils.hub import hub_delete  # noqa: PLC0415
    await hub_delete(BuiltinEntityType.CONVERSATION, conv_id, action="delete")


async def _hub_leave_conversation(conv_id: str) -> None:
    from flow_sdk.utils.hub import hub_post  # noqa: PLC0415
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
    from flow_sdk.utils.hub import HubError, hub_base_url  # noqa: PLC0415
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

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


async def handle_invitation_decline(
    invitation_id: str, someone_typeid: str,
) -> ApiResponse:
    """Decline a pending invitation hub-side AND remove the local row
    (along with the embedded Conversation + preview message that the
    new invitation pipeline materialized).
    """
    from flow_sdk.utils.hub import HubError, hub_base_url  # noqa: PLC0415
    from flow_sdk.builtin.invitation import Invitation as LocalInvitation  # noqa: PLC0415

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
        if not project_id:
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
        )
    except Exception as e:
        logger.error("[flow_message_action] conversation-create error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to create conversation: {str(e)}")


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
    asset_dest_root: Path | None = None,
    on_progress=None,
) -> bool:
    """Download the .flowmsg bundle from the hub and unpack it locally.

    Returns True if the bundle was successfully unpacked, False otherwise.

    ``asset_dest_root`` is forwarded to ``unpack_bundle`` to anchor FS-rooted
    assets (skill/agent) restored from the bundle. ``None`` falls through to
    ``unpack_bundle``'s lazy ``tempfile.mkdtemp()`` default.

    ``on_progress`` — optional async callback fired as download bytes land;
    when set the hub GET is streamed instead of buffered whole.
    """
    from flow_sdk.fs_records.flow_message_bundle import FlowMessageExistsError, unpack_bundle
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
            tmp_path, local_user_id, overwrite=False, asset_dest_root=asset_dest_root,
        )
        return True
    except FlowMessageExistsError:
        return True  # already materialized — counts as success
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
    """Return all non-archived received FlowMessages (excluding sent), newest first."""
    from flow_sdk.db.drivers.query import QueryFilter
    current_user = await User.get_one({"uname": "local"})
    current_user_id = current_user.id if current_user else None
    flt = QueryFilter(type=BuiltinEntityType.FLOW_MESSAGE.value)
    all_messages = await FlowMessage.get_all(flt)
    messages = [
        m for m in all_messages
        if not m.is_archived and m.sender_id != current_user_id
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
    or None if the message was skipped (no bundle) or the download/unpack failed.

    Every FlowMessage sent through flowpad includes a bundle — messages without
    one are not produced by any current send path and are skipped.
    """
    fm_id = (raw.get("id") or "").strip()
    if not fm_id:
        return None
    if await FlowMessage.get_one({"id": fm_id}):
        return fm_id
    attachment_filename = (raw.get("attachment_filename") or "").strip()
    if not attachment_filename:
        return None
    success = await _download_and_unpack_bundle(fm_id, attachment_filename)
    return fm_id if success else None


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
        raw_context = [str(c) for c in (local_fm.context_entities or [])]
    else:
        hub_data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
        attachment_filename = ((hub_data or {}).get("attachment_filename") or "").strip()
        raw_context = (hub_data or {}).get("context_entities") or []

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
        await _download_and_unpack_bundle(fm_id, attachment_filename)

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
    2. Append a pointer to `<task-dir>/conversation.jsonl` and bump
       `Conversation.message_ids` / `message_count`.
    3. Flip `is_draft=False`; save.
    4. POST to hub + upload bundle (best-effort).
    5. Git-commit the conversation pointer change when the task lives in a
       project repo (mirrors the original-reply path in
       `notification_action.handle_add_message`).
    """
    from flow_sdk.app.actions.notification_action import (
        _append_message_to_conversation,
        _find_task_conversation,
        _notify_ui_conversation_updated,
        _resolve_reply_recipient_email,
        _send_reply_to_hub,
    )
    from flow_sdk.utils.git import git_add_commit_push

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

    task: Optional[Task] = None
    task_typeid = conv.first_context_of_type(BuiltinEntityType.TASK.value)
    if task_typeid:
        task = await Task.get_one({"id": task_typeid.id})

    conv = await _append_message_to_conversation(
        conv=conv,
        task_id=task.id if task else None,
        fm_id=fm.id,
        someone_typeid=someone_typeid,
    )

    fm.is_draft = False
    fm = await fm.save(someone_typeid)

    if task:
        from flow_sdk.app.actions.notification_action import _resolve_reply_recipient_participant

        sender_participant = await User.current_sender_participant(fm.sender_name)
        sender_id = sender_participant.get("user_id") or None
        if not sender_id:
            sender_id = fm.sender_id
        sender_name = sender_participant.get("name") or ""
        sender_email = sender_participant.get("email") or ""
        recipient_participant = _resolve_reply_recipient_participant(
            task,
            conv,
            sender_email,
            sender_id or "",
        )
        recipient_email = recipient_participant.get("email") or _resolve_reply_recipient_email(
            task,
            conv,
            sender_email,
            sender_id or "",
        )
        await _send_reply_to_hub(
            reply_fm=fm,
            task=task,
            conv_title=(conv.name or "") if conv else "",
            message=fm.text or "",
            sender_id=sender_id,
            sender_name=sender_name,
            recipient_email=recipient_email,
            participants=list(conv.participants or []),
        )

    _notify_ui_conversation_updated(conv.id, task.id if task else "", fm.id)

    if task:
        project_root_str = task.project_root
        if project_root_str:
            await git_add_commit_push(
                Path(project_root_str),
                ["tasks"],
                f"chore: update conversation for task '{task.title}'",
            )

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
    existing_inv = await LocalInvitation.get_one({"id": inv_id})
    inv_fields = {
        "id": inv_id,
        "recipient_email": hub_inv.get("recipient_email") or "",
        "accepted": bool(hub_inv.get("accepted") or False),
        "sent": bool(hub_inv.get("sent") or False),
        "message": hub_inv.get("message"),
        "remote": True,
    }
    if existing_inv:
        existing_inv.recipient_email = inv_fields["recipient_email"]
        existing_inv.accepted = inv_fields["accepted"]
        existing_inv.sent = inv_fields["sent"]
        existing_inv.message = inv_fields["message"]
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
        rec = ConversationRecord.from_jsonl(
            ConversationRecord.default_jsonl_path(conv_id),
            parent_id="", record_id=conv_id, parent_type=RecordType.PROJECT,
        )
        rec.save()
    except Exception as e:  # noqa: BLE001
        logger.warning("[inv-materialize] jsonl init failed: %s", e)

    # Materialize the embedded preview FlowMessage. The UI keys off
    # ``kind='invitation'`` to render the invitation row, and reads the
    # Invitation TypeId out of ``context_entities`` for the Accept button.
    # notify=False here too — the explicit CREATE ops below announce the
    # FlowMessage and Conversation together, in load-bearing order, only
    # once the conversation already carries its invitation-kind first
    # message. Without this the strip/inbox briefly render a navigable row.
    preview = hub_inv.get("preview_message")
    invitation_typeid = f"{LocalInvitation.get_type()}-{inv_id}"
    inv_fm = None
    if isinstance(preview, dict):
        msg_payload = dict(preview)
        msg_payload.setdefault("text", local_inv.message or "You've been invited to a conversation")
        msg_payload["kind"] = FlowMessageKind.INVITATION.value
        existing_ctx = msg_payload.get("context_entities") or []
        if invitation_typeid not in existing_ctx:
            existing_ctx = list(existing_ctx) + [invitation_typeid]
        msg_payload["context_entities"] = existing_ctx
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
        # Defensive: even with no preview, ensure there's an invitation-kind
        # message so the UI's invitation-row branch matches. Synthesize one
        # locally so accept-flow stays consistent with older hub builds.
        synth_payload = {
            "text": (local_inv.message or "You've been invited to a conversation"),
            "kind": FlowMessageKind.INVITATION.value,
            "context_entities": [invitation_typeid],
            "remote": False,
        }
        try:
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


def _dispatch_conversation_message_fetch(conv_id: str, someone_typeid: str) -> None:
    """Fire-and-forget kickoff for a per-conversation message catch-up.

    Idempotent: if a fetch is already in-flight for this ``conv_id``, the new
    dispatch is a no-op. The lock is held inside the spawned task, not by the
    dispatcher, so callers never block.
    """
    existing = _conv_fetch_locks.get(conv_id)
    if existing is not None and existing.locked():
        return
    asyncio.create_task(
        _fetch_conversation_messages(conv_id, someone_typeid),
        name=f"conv-msg-fetch-{conv_id[:8]}",
    )


async def _fetch_conversation_messages(conv_id: str, someone_typeid: str) -> None:
    """Bring local message state for a single conversation up to the hub's.

    Reads the hub conversation's ``message_ids`` projection (already JSON-encoded
    ``[{typeid, ts}, ...]``), diffs against the local on-disk pointer index,
    and for each missing pointer downloads + unpacks the bundle via the same
    production path used by `_process_single_hub_message`.

    All exceptions are logged and swallowed — this runs as a detached task and
    must never crash the event loop.
    """
    lock = _conv_fetch_locks.setdefault(conv_id, asyncio.Lock())
    async with lock:
        try:
            hub_conv = await hub_get(BuiltinEntityType.CONVERSATION, conv_id)
            if not isinstance(hub_conv, dict):
                return
            raw_ids = hub_conv.get("message_ids")
            if not raw_ids:
                return
            try:
                hub_pointers = _json.loads(raw_ids) if isinstance(raw_ids, str) else raw_ids
            except (ValueError, TypeError):
                logger.warning("[conv-msg-fetch] %s: bad message_ids payload", conv_id[:8])
                return
            try:
                rec = ConversationRecord.from_jsonl(
                    ConversationRecord.default_jsonl_path(conv_id),
                    parent_id="", record_id=conv_id, parent_type=RecordType.PROJECT,
                )
                local_ids = {p.id for p in rec.message_pointers()}
            except Exception:  # noqa: BLE001
                local_ids = set()
            missing_fm_ids: list[str] = []
            for raw_ptr in hub_pointers:
                typeid_str = (raw_ptr or {}).get("typeid") or ""
                dash = typeid_str.find("-")
                if dash <= 0:
                    continue
                fm_id = typeid_str[dash + 1:].lstrip("@")
                if fm_id and fm_id not in local_ids:
                    missing_fm_ids.append(fm_id)
            if not missing_fm_ids:
                return
            logger.info(
                "[conv-msg-fetch] %s: fetching %d missing message(s)",
                conv_id[:8], len(missing_fm_ids),
            )
            for fm_id in missing_fm_ids:
                try:
                    raw_fm = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
                    if isinstance(raw_fm, dict):
                        await _process_single_hub_message(raw_fm)
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        "[conv-msg-fetch] %s: fm=%s failed: %s",
                        conv_id[:8], fm_id, e,
                    )
        except Exception as e:  # noqa: BLE001
            logger.warning("[conv-msg-fetch] %s: aborted: %s", conv_id[:8], e)


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
    first one) need this explicit pull. Unlike ``_fetch_conversation_messages``
    (legacy ``.flowmsg`` bundle path), this is the text-only path — the hub
    payload is materialized directly with no bundle download.
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
            )
        except Exception as fm_err:  # noqa: BLE001
            logger.warning(
                "[conv-sync] conv=%s fm=%s materialize failed: %s",
                conv_id[:8], raw_fm.get("id"), fm_err,
            )


async def _upsert_hub_conversation_metadata(
    hub_conv: dict, someone_typeid: str, *, notify: bool = True,
) -> Optional[Conversation]:
    """Upsert a hub-side Conversation into the local SQLite table.

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
    existing = await Conversation.get_one({"id": conv_id})
    if existing is None:
        payload: dict = {"id": conv_id, "remote": True}
        for k in ("title", "participants", "remote_project_id", "remote_project_name"):
            if hub_conv.get(k) is not None:
                payload[k] = hub_conv[k]
        # Hub owner field ``initiated_by`` mirrors locally as ``created_by``.
        if hub_conv.get("initiated_by"):
            payload["created_by"] = hub_conv["initiated_by"]
        if hub_conv.get("message_status_visible") is not None:
            payload["message_status_visible"] = bool(hub_conv["message_status_visible"])
        conv = Conversation.model_validate(payload)
        conv.id = conv_id
        return await conv.save(someone_typeid, notify=notify)
    # Update path: copy hub-owned fields without touching projections.
    changed = False
    for k in ("title", "participants", "remote_project_id", "remote_project_name"):
        v = hub_conv.get(k)
        if v is not None and getattr(existing, k, None) != v:
            setattr(existing, k, v)
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
    if changed:
        return await existing.save(someone_typeid, notify=notify)
    return existing


async def handle_conversation_list(someone_typeid: str) -> ApiResponse:
    """Unified conversation list: local SQLite + hub catch-up + background message fetch.

    Pipeline (all stages run inside the request handler unless noted):

    1. Read local conversations from SQLite (the canonical render source).
    2. In parallel, hub_get(CONVERSATION) + hub_get(INVITATION, pending).
       Failures here are non-fatal — we degrade to local-only with a flag.
    3. For each hub conversation, upsert metadata locally (title, participants,
       etc.). Compute ``hub.message_count - local.message_count`` — if positive,
       queue a single-flight background fetch.
    4. For each pending invitation, run the existing
       ``_materialize_remote_invitation`` + placeholder-conversation pipeline.
    5. Return the freshly-merged local list. Background fetches run after the
       HTTP response is sent; their results stream in via WS data_op_msg.
    """
    if not hub_base_url():
        # Local-only mode: still return whatever's in SQLite so the UI renders.
        local = await Conversation.get_all({})
        return ApiSuccessResponse(data={
            "conversations": [c.model_dump(mode="json") for c in local],
            "bg_fetch_dispatched": [],
            "hub_reachable": False,
            "auth_required": False,
        })

    local_list = await Conversation.get_all({})
    local_index = {c.id: c for c in local_list if c.id}

    # Peek at credential state up front so we can flag ``auth_required`` even
    # when the underlying hub_get swallows the 401 (it returns None on any
    # non-200). Missing credentials is the most common reason the hub call
    # comes back empty; assume that case and refine if the hub IS reachable
    # for some calls but rejects others.
    try:
        from flow_sdk.cli.auth.credentials import load_credentials  # noqa: PLC0415
        creds_present = bool(load_credentials() and load_credentials().api_key)
    except Exception:  # noqa: BLE001
        creds_present = False

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

    # If both hub calls came back empty AND we never had credentials, the
    # hub returned 401 (or we never authenticated) — flag auth_required so
    # the UI routes to LoginDialog instead of showing a generic error.
    if not hub_reachable and not creds_present:
        auth_required = True

    # (c) upsert hub conversation metadata; dispatch per-conv message fetch
    # when the hub has more messages than we do locally.
    bg_fetch_dispatched: list[str] = []
    for hub_conv in hub_convs:
        try:
            await _upsert_hub_conversation_metadata(hub_conv, someone_typeid)
        except Exception as e:  # noqa: BLE001
            logger.warning("[conv-list] upsert conv=%s failed: %s",
                           (hub_conv.get("id") or "?")[:8], e)
            continue
        hub_count = int(hub_conv.get("message_count") or 0)
        local_conv = local_index.get(hub_conv.get("id"))
        local_count = int((local_conv.message_count if local_conv else 0) or 0)
        if hub_count > local_count:
            conv_id = hub_conv.get("id")
            if conv_id:
                _dispatch_conversation_message_fetch(conv_id, someone_typeid)
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

    # (f) return the freshly-merged list. Background tasks finish after the
    # response, fanning out their writes via data_op_msg WS frames.
    merged = await Conversation.get_all({})
    return ApiSuccessResponse(data={
        "conversations": [c.model_dump(mode="json") for c in merged],
        "bg_fetch_dispatched": bg_fetch_dispatched,
        "pruned_ids": pruned_ids,
        "hub_reachable": hub_reachable,
        "auth_required": auth_required,
    })


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
        if resp.status_code != 200:
            return ApiFailResponse(
                message=f"Accept failed ({resp.status_code}): {resp.text[:200]}"
            )
        # The accept response carries the chosen target's typeid. Two shapes:
        #  - FlowMessage  → legacy bundle flow; we'll download + unpack below.
        #  - Conversation → direct-share invite flow; we call ``join`` so the
        #    caller enters ``Conversation.participants`` (which is what hub
        #    fanout walks). Without that join, accept grants the ``member``
        #    role but realtime delivery never reaches us.
        try:
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
            from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

            creds = load_credentials()
            if creds and creds.api_key:
                async with FlowpadClient(ApiConfig.from_env(), api_key=creds.api_key) as client:
                    await client.post(f"/graph/conversation/{linked_conv_id}/join", {})
                    hub_conv = await client.get(f"/graph/conversation/{linked_conv_id}")
                if isinstance(hub_conv, dict) and hub_conv.get("id"):
                    existing = await Conversation.get_one({"id": linked_conv_id})
                    if existing is None:
                        await Conversation.model_validate({
                            "id": linked_conv_id,
                            "title": hub_conv.get("title"),
                            "remote": True,
                        }).save(someone_typeid)
                # Pull the inviter's pre-accept messages — the hub WS only
                # fanouts from join-time forward, so without this the first
                # message stays invisible until a manual refresh.
                await _sync_conversation_messages(linked_conv_id, someone_typeid)
        except Exception as e:
            logger.warning("[invitation-accept] hub join+materialize failed: %s", e, exc_info=True)

    # Mark local invitation as accepted (best-effort).
    try:
        from flow_sdk.builtin.invitation import Invitation as LocalInvitation
        existing = await LocalInvitation.get_one({"id": inv_id})
        if existing:
            existing.accepted = True
            await existing.save(someone_typeid)
    except Exception as e:
        logger.warning("[invitation-accept] local update failed: %s", e)

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
                bundle_unpacked = await _download_and_unpack_bundle(linked_fm_id, attachment_filename)
        except Exception as e:
            logger.warning("[invitation-accept] bundle download failed: %s", e)

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
#   - `derive-task`: pre-creates a Task entity (placeholder title from FM text,
#     `context_entities = [FM, AgenticProcess]`) and a Run row, then spawns an
#     invisible Claude session whose only job is to **update** the Task's
#     title/description via the flow MCP. Pre-creating in Python guarantees a
#     real Task in the DB regardless of whether Claude succeeds at the MCP
#     round-trip; the row appears immediately and the Run lifecycle drives the
#     Open-button enable in the conversation drawer.
#
#   - `start-cc-from-transcript`: when the message has a `conversation.jsonl`
#     FILE attachment, spawn a Claude session pre-loaded with that transcript
#     path and ask for a brief analysis. The new AgenticProcess pins
#     `target_typeid_str = <fm typeid>` so the frontend query picks it up.
#
# Both actions return immediately with `process_id`; the entity-query channel
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


async def handle_derive_task(fm_id: str, someone_typeid: str) -> ApiResponse:
    """Pre-create a Task linked to this FM, then run a headless Claude turn to refine it.

    The Task is allocated up front with placeholder content so the row appears
    immediately regardless of whether the run succeeds. Claude's job is only
    to **update** the placeholder's title/description via the flow MCP — never
    to create the Task from scratch.
    """
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeCliOptions

    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}")

    workdir, project_id = await _resolve_workdir_and_project_async(fm)
    if not workdir:
        workdir = os.path.expanduser("~")

    fm_typeid = TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm.id)
    fm_typeid_str = str(fm_typeid)

    # 1. Spawn the invisible AgenticProcess pinned to this FM. ``target_typeid_str``
    #    surfaces it in Private Context / Runs queries.
    cli_opts = ClaudeCliOptions(
        print_mode=True,
        output_format="stream-json",
        verbose=True,
        permission_mode="bypassPermissions",
    )
    process = AgenticProcess(
        cli_config=cli_opts.to_json(),
        workdir=workdir,
        visible=False,
        project_id=project_id,
        target_typeid_str=fm_typeid_str,
        context_entities=[fm_typeid],
    )
    await process.save(someone_typeid)
    process_typeid = TypeId(type=BuiltinEntityType.AGENTIC_PROCESS.value, id=process.id)

    fm_text = (fm.text or "").strip()
    placeholder_title = (fm_text[:80] + "…") if len(fm_text) > 80 else (fm_text or "Deriving task…")
    task = Task.model_validate({
        "title": placeholder_title,
        "description": fm_text or None,
        "project_id": project_id,
        "context_entities": [fm_typeid, process_typeid],
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)
    task_typeid_str = str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id))

    instruction = (
        "A Task entity has been pre-created with id `" + task.id + "` "
        "(typeid `" + task_typeid_str + "`). Its current title and description "
        "are placeholder values sliced from the source FlowMessage text.\n\n"
        "Your job: refine the Task by **updating** its `title` (concise one-line "
        "summary) and `description` (the relevant details). Do NOT create a new "
        "Task — update the existing one.\n\n"
        "Steps:\n"
        "1. Read the source FlowMessage with TypeId `" + fm_typeid_str + "` for "
        "context. You can call the flow MCP:\n"
        "   `mcp__plugin_skillit_flow_sdk__flow_entity_crud` with arguments\n"
        "   `crud=\"read\"`, "
        "`entity_json='{\"type\":\"flow_message\",\"id\":\"" + fm.id + "\"}'`.\n"
        "2. Update the Task with the same MCP tool:\n"
        "   `crud=\"update\"`, "
        "`entity_json='{\"type\":\"task\",\"id\":\"" + task.id + "\",\"title\":\"<new title>\",\"description\":\"<new description>\"}'`.\n"
        "3. Exit when done."
    )

    await process.prompt(instruction)

    return ApiSuccessResponse(data={
        "process_id": process.id,
        "task_id": task.id,
    })


@action.post(action_name="derive-task", types=[BuiltinEntityType.FLOW_MESSAGE.value])
async def derive_task() -> ApiResponse:
    """Headless: derive a Task from this FlowMessage; result links via context_entities."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        return await handle_derive_task(
            fm_id=str(request_info.target_entity_typeid.id),
            someone_typeid=request_info.someone_typeid,
        )
    except Exception as e:
        logger.error("[flow_message_action] derive-task error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Derive task failed: {str(e)}")


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
