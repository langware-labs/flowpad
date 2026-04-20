"""HTTP actions for FlowMessage file transport.

  POST /api/v1/graph/flow-message-upload      — upload .flowmsg (multipart, global action)
  POST /api/v1/graph/flow-message-create      — create task+spec+conv+FlowMessage locally, no email/git
  GET  /api/v1/graph/flow_message/{id}/file-download  — download .flowmsg (entity-scoped)
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
from flow_sdk.config import FLOW_HOME
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_records.conversation_record import ConversationRecord
from flow_sdk.fs_records.flow_message_bundle import FlowMessageExistsError
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk._compat import UTC

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
        "metadata": {"team_space_id": team_space_id} if team_space_id else None,
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)

    # 3. Create Conversation + conversation.jsonl under FLOW_HOME/tasks/<slug>-<id>/
    task_dir = FLOW_HOME / "tasks" / f"{_meaningful_name(task_title)}-{task.id[:8]}"
    task_dir.mkdir(parents=True, exist_ok=True)
    jsonl_path = task_dir / "conversation.jsonl"
    jsonl_path.touch()

    conv = Conversation.model_validate({
        "task_id": task.id,
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
        overwrite = overwrite_qp.lower() in ("true", "1", "yes")
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
        )
    except Exception as e:
        logger.error(f"[flow_message_action] create-task-bundle error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to create task bundle: {str(e)}")


@action.get(action_name="flow_message.open")
async def open_flow_message() -> ApiResponse:
    """Deep-link handler: fetch FlowMessage from hub, redirect to IncomingTaskDialog."""
    from flow_sdk.server.routes.notify import handle_notification_deep_link
    from flow_sdk.utils.hub import hub_get

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found", status_code=400)

    flow_message_id = str(request_info.target_entity_typeid.id)
    data = await hub_get("flow_message", flow_message_id)

    meta = (data or {}).get("metadata") or {}
    return await handle_notification_deep_link(
        project_url=(meta.get("project_url") or (data or {}).get("project_url") or "").strip(),
        task_id=(meta.get("task_id") or (data or {}).get("task_id") or "").strip(),
        branch=(meta.get("branch") or (data or {}).get("branch") or "").strip(),
        repo_id=(meta.get("repo_id") or (data or {}).get("repo_id") or "").strip(),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        task_title=(meta.get("task_title") or meta.get("spec_title") or (data or {}).get("task_title") or "").strip(),
    )


@action.get(action_name="file-download", types=["flow_message"])
async def download_flow_message() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")

        return await handle_download_flow_message(str(request_info.target_entity_typeid.id))
    except Exception as e:
        logger.error(f"[flow_message_action] download error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Download failed: {str(e)}")
