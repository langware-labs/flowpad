"""HTTP actions for FlowMessage file transport.

  POST /api/v1/graph/flow-message-upload      — upload .flowmsg (multipart, global action)
  POST /api/v1/graph/flow-message-create      — create task+spec+conv+FlowMessage locally, no email/git
  GET  /api/v1/graph/flow_message/{id}/create-and-download-local-flowmsg  — download .flowmsg (entity-scoped)
  GET  /api/v1/graph/flow_message/{id}/open   — deep-link: fetch from hub and open IncomingTaskDialog
"""
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
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
from flow_sdk.builtin.spec import Spec
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_records.conversation_record import ConversationRecord
from flow_sdk.fs_records.flow_message_bundle import FlowMessageExistsError
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk._compat import UTC
from flow_sdk.utils.hub import hub_get

logger = logging.getLogger(__name__)


def _meaningful_name(title: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return name[:60] or "untitled"


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

    task_id = next((c.id for c in fm.context if c.type == BuiltinEntityType.TASK.value), None)
    conv_id = next((c.id for c in fm.context if c.type == BuiltinEntityType.CONVERSATION.value), None)

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
    local_user = await User.get_one({"uname": "local"})
    sender_id: Optional[str] = local_user.id if local_user else None
    sender_name: str = (local_user.name or local_user.email or "") if local_user else ""

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
        "spec_id": spec.id,
        "shared_by_id": sender_id,
        "team_space_id": team_space_id or None,
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)

    # 3. Create Conversation + conversation.jsonl under <tasks_dir>/<slug>-<id>/
    task_dir = get_instance_settings().tasks_dir / f"{_meaningful_name(task_title)}-{task.id[:8]}"
    task_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = task_dir / "conversation.jsonl"
    jsonl_path.touch()

    conv = Conversation.model_validate({
        "task_id": task.id,
        "project_id": project_id,
        "data_path": str(jsonl_path),
        "message_count": 0,
    })
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(someone_typeid)
    await task.attach_child(conv)

    rec = ConversationRecord.from_jsonl(jsonl_path, task.id, conv.id)
    rec.save()
    rec.link_to_parent_record()

    task.conversation_id = conv.id
    task = await task.save(someone_typeid)

    # 4. Create FlowMessage record
    context = [
        TypeId(type=BuiltinEntityType.TASK.value, id=task.id),
        TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id),
    ]

    fm = FlowMessage.model_validate({
        "text": message or f"Task: {task_title}",
        "context": context,
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "conversation_id": conv.id,
    })
    fm.id = FlowMessage.allocate_id(fm.model_dump())
    fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.SPEC.value, id=spec.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm.id))),
    ]
    fm = await fm.save(someone_typeid)

    # Append pointer to conversation
    bundle_ts = datetime.now(UTC).isoformat()
    rec.append_message_pointer(fm.id, bundle_ts)
    conv.message_ids = _json.dumps([{"message_id": fm.id, "timestamp": bundle_ts}])
    conv.message_count = 1
    conv = await conv.save(someone_typeid)

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

    task_id = (meta.get("task_id") or (data or {}).get("task_id") or "").strip()
    attachment_filename = ((data or {}).get("attachment_filename") or "").strip()

    # Always download/unpack the specific message's bundle — even if the task exists
    # locally. The bundle may carry new conversation pointers (e.g. a reply) that
    # need to be merged into the local conversation; skipping it would leave the
    # UI showing only previous messages.
    if not repo_url and task_id and attachment_filename:
        try:
            await _download_and_unpack_bundle(fm_id, attachment_filename)
        except Exception as e:
            logger.warning("[open_flow_message] failed to materialize bundle (non-fatal): %s", e)

    return await handle_notification_deep_link(
        task_id=task_id,
        project_url=repo_url,
        branch=(meta.get("branch") or (data or {}).get("branch") or "").strip(),
        repo_id=(meta.get("repo_id") or (data or {}).get("repo_id") or "").strip(),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        task_title=(meta.get("task_title") or meta.get("spec_title") or (data or {}).get("task_title") or "").strip(),
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
    from flow_sdk.fs_store.record_types import RecordType

    project = await Project.get_one({"id": project_id})
    if not project:
        return ApiFailResponse(message=f"Project not found: {project_id}", status_code=404)
    if not project.fs_storage_mount_path:
        return ApiFailResponse(message="Project has no fs_storage_mount_path")

    resolved: list[dict] = []
    for p in participants or []:
        email = (p.get("email") or "").strip()
        if not email:
            continue
        name = (p.get("name") or "").strip() or None
        user = await User.get_or_create_by_email(email, name=name)
        resolved.append({"user_id": user.id, "email": user.email, "name": user.name})

    slug_seed = "-".join(p["email"].split("@")[0] for p in resolved) or "conversation"
    slug = _meaningful_name(slug_seed)

    derived_name = (title or "").strip() or (
        ", ".join(p.get("name") or p.get("email") for p in resolved if p.get("email")) or None
    )

    conv = Conversation.model_validate({
        "task_id": None,
        "project_id": project.id,
        "participants": resolved,
        "message_count": 0,
        "name": derived_name,
    })
    conv.id = Conversation.allocate_id(conv.model_dump())

    conv_dir = Path(project.fs_storage_mount_path) / "conversations" / f"{slug}-{conv.id[:8]}"
    conv_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = conv_dir / "conversation.jsonl"
    jsonl_path.touch()

    conv.data_path = str(jsonl_path)
    conv = await conv.save(someone_typeid)
    await project.attach_child(conv)

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


async def _download_and_unpack_bundle(fm_id: str, attachment_filename: str) -> bool:
    """Download the .flowmsg bundle from the hub and unpack it locally.

    Returns True if the bundle was successfully unpacked, False otherwise.
    """
    from flow_sdk.fs_records.flow_message_bundle import FlowMessageExistsError, unpack_bundle
    bundle_bytes = await hub_get(
        BuiltinEntityType.FLOW_MESSAGE, fm_id, "fs", f"download/{attachment_filename}", raw=True
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
        await unpack_bundle(tmp_path, local_user_id, overwrite=False)
        return True
    except FlowMessageExistsError:
        return True  # already materialized — counts as success
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
    attachment_filename = (raw.get("attachment_filename") or "").strip()
    if not attachment_filename:
        return None
    success = await _download_and_unpack_bundle(fm_id, attachment_filename)
    return fm_id if success else None


async def handle_inbox_fetch(someone_typeid: str) -> ApiResponse:
    """Pull new FlowMessages from hub, materialize bundles locally."""
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
        raw_context = [str(c) for c in (local_fm.context or [])]
    else:
        hub_data = await hub_get(BuiltinEntityType.FLOW_MESSAGE, fm_id)
        attachment_filename = ((hub_data or {}).get("attachment_filename") or "").strip()
        raw_context = (hub_data or {}).get("context") or []

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


async def handle_send_draft(fm_id: str, someone_typeid: str) -> ApiResponse:
    """Promote a draft FlowMessage to a real reply.

    1. Validate `is_draft=True`.
    2. Append a pointer to `<task-dir>/conversation.jsonl` and bump
       `Conversation.message_ids` / `message_count`.
    3. Flip `is_draft=False`; save.
    4. POST to hub + upload bundle (best-effort).
    5. Git-commit the conversation pointer change when the task lives in a
       project repo (mirrors the original-reply path in
       `notification_action.handle_append_conversation`).
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
    if conv.task_id:
        task = await Task.get_one({"id": conv.task_id})

    conv = await _append_message_to_conversation(
        conv=conv,
        task_id=task.id if task else None,
        fm_id=fm.id,
        someone_typeid=someone_typeid,
    )

    fm.is_draft = False
    fm = await fm.save(someone_typeid)

    if task:
        local_user = await User.get_one({"uname": "local"})
        sender_id = local_user.id if local_user else fm.sender_id
        sender_name = fm.sender_name or ((local_user.name or local_user.email or "") if local_user else "")
        recipient_email = _resolve_reply_recipient_email(task, local_user.id if local_user else "")
        await _send_reply_to_hub(
            reply_fm=fm,
            task=task,
            task_id=task.id,
            message=fm.text or "",
            sender_id=sender_id,
            sender_name=sender_name,
            recipient_email=recipient_email,
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
