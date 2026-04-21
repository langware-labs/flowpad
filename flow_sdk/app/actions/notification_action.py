"""Action handler for sending cross-user notifications.

Sender flow:
  1. Create Spec + Task + Conversation entities in local DB
  2. Write spec.md, task manifest, and conversation.jsonl to git repo under tasks/
  3. Git push
  4. POST notification to Flowpad Hub (which stores it and emails recipient)

File layout (all inside the git repo, committed and pushed):
  tasks/<task-title>/manifest.json          — task metadata for scanner
  tasks/<task-title>/conversation.jsonl     — messages (one JSON object per line)
  tasks/spec/<spec-title>/spec.md           — spec content (markdown + frontmatter)

Routes:
  POST /api/v1/graph/share_task
  POST /api/v1/graph/notification/{id}/append-conversation
  POST /api/v1/graph/notification/{id}/refresh
  GET  /api/v1/graph/notification/{id}/open
"""

import asyncio
import json as _json
import logging
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from flow_sdk._compat import UTC
from flow_sdk.actions.action_registry import action
from flow_sdk.core.network.connection import Notification
from flow_sdk.flowpad_types.enums.entity_enums import (
    CrudAction,
    DeliveryMethod,
    NotificationStatus,
    NotificationType,
)
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.fs_store import SyncOperation
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk.utils.git import find_project_root, git_add_commit_push, git_current_branch, git_pull, git_remote_url, git_repo_full_name, repo_id
from flow_sdk.utils.hub import hub_base_url, hub_get, hub_post, hub_put
from flow_sdk.builtin.bookmark import Bookmark

logger = logging.getLogger(__name__)


def _unique_dir_name(base_name: str, parent: Path) -> str:
    """Return a directory name that doesn't already exist under parent."""
    if not (parent / base_name).exists():
        return base_name
    counter = 2
    while (parent / f"{base_name}-{counter}").exists():
        counter += 1
    return f"{base_name}-{counter}"


def _meaningful_name(title: str) -> str:
    """Convert a title to a filesystem-safe directory name (no random IDs)."""
    name = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return name[:60] or "untitled"


async def _create_conversation_entity(
    task: Task,
    conversation_jsonl_path: Path,
    someone_typeid: str,
) -> Conversation:
    """Create an empty Conversation entity + empty conversation.jsonl (pointer-index).

    Attaches the conversation as a child of the task in the DB.
    Message content lives in FlowMessage records; pointers are appended after creation.
    """
    from flow_sdk.fs_records.conversation_record import ConversationRecord

    conversation_jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    conversation_jsonl_path.touch()

    conv = Conversation.model_validate({
        "task_id": task.id,
        "data_path": str(conversation_jsonl_path),
        "message_count": 0,
    })
    conv.id = Conversation.allocate_id(conv.model_dump())
    conv = await conv.save(someone_typeid)

    # DB-level parent-child composition
    await task.attach_child(conv)

    # Record-level parent-child composition (conversation → task via parent_ref)
    rec = ConversationRecord.from_jsonl(conversation_jsonl_path, task.id, conv.id)
    rec.save()
    # Bidirectional: add conversation to task's children_refs
    rec.link_to_parent_record()

    return conv


async def handle_send_notification(body: dict, someone_typeid: str) -> ApiResponse:
    """Create Spec + Task + Conversation, write to git repo, push, post to hub."""
    recipient_id = (body.get("recipient_id") or "").strip()
    spec_title = (body.get("spec_title") or "").strip()
    spec_content = (body.get("spec_content") or "").strip()
    spec_type = (body.get("spec_type") or "plan").strip()
    task_title = (body.get("task_title") or spec_title).strip()
    message = (body.get("message") or "").strip() or None
    plan_id = (body.get("plan_id") or "").strip() or None
    project_path = (body.get("project_path") or "").strip() or None
    team_space_id = (body.get("team_space_id") or "").strip() or None

    if not recipient_id:
        return ApiFailResponse(message="recipient_id is required")
    if not spec_title:
        return ApiFailResponse(message="spec_title is required")

    # Resolve recipient — accept email address or user ID
    recipient_user = await User.get_one({"id": recipient_id})
    if not recipient_user:
        recipient_user = await User.get_one({"email": recipient_id})

    recipient_email: Optional[str] = None
    resolved_recipient_id: str = recipient_id
    if recipient_user:
        recipient_email = recipient_user.email
        resolved_recipient_id = recipient_user.id
    elif "@" in recipient_id:
        recipient_email = recipient_id
    else:
        return ApiFailResponse(message=f"Recipient not found: {recipient_id}")

    local_user = await User.get_one({"uname": "local"})
    sender_id: Optional[str] = local_user.id if local_user else None
    sender_name: str = (local_user.name or local_user.email or "") if local_user else ""

    project_root = find_project_root(project_path) if project_path else None
    project_url = git_remote_url(project_root) if project_root else ""
    repo_full_name = git_repo_full_name(project_root) if project_root else ""
    repo_id_val = repo_id(repo_full_name) if repo_full_name else ""

    # 1. Create Spec entity
    spec = Spec.model_validate({
        "title": spec_title,
        "content": spec_content,
        "spec_type": spec_type,
        "plan_id": plan_id,
        "author_id": sender_id,
    })
    spec.id = Spec.allocate_id(spec.model_dump())
    spec = await spec.save(someone_typeid)

    # 2. Create Task entity (conversation_id set after Conversation is created)
    task_meta: dict = {
        "sender_name": sender_name,
        "sender_email": local_user.email if local_user else "",
        "recipient_email": recipient_email or "",
    }
    if team_space_id:
        task_meta["team_space_id"] = team_space_id
    task = Task.model_validate({
        "title": task_title,
        "spec_id": spec.id,
        "shared_by_id": sender_id,
        "metadata": task_meta,
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)

    # 2a. Register task on hub so the recipient can load it via the hub graph API.
    # The hub's generic create endpoint stores it in Neo4j with owner access for the sender.
    await hub_post(BuiltinEntityType.TASK, {
        "id": task.id,
        "title": task_title,
        "task_type": task.task_type,
        "status": task.status,
    })

    # 3. Write spec + manifest + conversation.jsonl to git repo
    conversation_id: Optional[str] = None
    spec_file_path = ""
    fm = None
    if project_root:
        tasks_root = Path(project_root) / "tasks"
        spec_root = tasks_root / "spec"

        spec_dir_name = _unique_dir_name(_meaningful_name(spec_title), spec_root)
        task_dir_name = _unique_dir_name(_meaningful_name(task_title), tasks_root)

        spec_file_path = f"tasks/spec/{spec_dir_name}/spec.md"

        spec_dir = spec_root / spec_dir_name
        spec_dir.mkdir(parents=True, exist_ok=True)
        (spec_dir / "spec.md").write_text(
            f"---\ntitle: \"{spec_title}\"\nspec_type: {spec_type}\n"
            f"spec_id: {spec.id}\nauthor_id: {sender_id or ''}\nplan_id: {plan_id or ''}\n---\n\n{spec_content}",
            encoding="utf-8",
        )

        task_dir = tasks_root / task_dir_name
        task_dir.mkdir(parents=True, exist_ok=True)

        # 3a. Create Conversation entity + conversation.jsonl (empty pointer-index)
        conv = await _create_conversation_entity(
            task,
            task_dir / "conversation.jsonl",
            someone_typeid,
        )
        conversation_id = conv.id

        # Update task with conversation_id
        task.conversation_id = conversation_id
        task = await task.save(someone_typeid)

        # 3b. Save FlowMessage record for this initial share
        from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
        from flow_sdk.fs_store.type_id import TypeId
        fm_context = [
            TypeId(type=BuiltinEntityType.TASK.value, id=task.id),
            TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conversation_id),
        ]
        fm = FlowMessage.model_validate({
            "text": message or f"Task shared: {task_title}",
            "context": fm_context,
            "attachment": [],
            "sender_id": sender_id,
            "sender_name": sender_name,
            "receiver_address": recipient_email,
            "receiver_address_type": "email",
        })
        fm.id = FlowMessage.allocate_id(fm.model_dump())
        fm.attachment = [
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.SPEC.value, id=spec.id))),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id))),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conversation_id))),
            Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm.id))),
        ]
        fm = await fm.save(someone_typeid)

        # Append FlowMessage pointer to conversation + keep message_ids in sync
        fm_ts = datetime.now(UTC).isoformat()
        if conv.data_path:
            from flow_sdk.fs_records.conversation_record import ConversationRecord
            rec = ConversationRecord.from_jsonl(Path(conv.data_path), task.id, conv.id)
            rec.append_message_pointer(fm.id, fm_ts)
        existing_ids: list = []
        if conv.message_ids:
            try:
                existing_ids = _json.loads(conv.message_ids)
            except Exception:
                existing_ids = []
        existing_ids.append({"message_id": fm.id, "timestamp": fm_ts})
        conv.message_ids = _json.dumps(existing_ids)
        conv.message_count = len(existing_ids)
        conv = await conv.save(someone_typeid)

        # 3c. Write manifest
        branch_at_write = git_current_branch(project_root) if project_root else ""
        (task_dir / "manifest.json").write_text(
            _json.dumps({
                "task_id": task.id,
                "title": task_title,
                "spec_id": spec.id,
                "spec_dir": spec_dir_name,
                "shared_by_id": sender_id,
                "sender_name": sender_name,
                "conversation_id": conversation_id,
                "created_at": datetime.now(UTC).isoformat(),
                "repo_id": repo_id_val,
                "branch": branch_at_write,
            }, indent=2, default=str),
            encoding="utf-8",
        )

    # 4. Git push — if it fails, abort before sending the email
    if project_root:
        push_result = await git_add_commit_push(project_root, ["tasks"], f"chore: share task '{task_title}'")
        git_error: Optional[str] = None
        if not push_result.ok and push_result.message and "Nothing to commit" not in push_result.message:
            git_error = push_result.message
        elif push_result.warning:
            git_error = push_result.warning
        if git_error:
            return ApiSuccessResponse(data={"sent": False, "git_error": git_error})

    # 5. Post to hub
    branch = git_current_branch(project_root) if project_root else ""
    hub_configured = bool(hub_base_url())
    flow_message_id = str(uuid.uuid4())
    hub_data = await hub_post(BuiltinEntityType.FLOW_MESSAGE, {
        "flow_message_id": flow_message_id,
        "recipient_email": recipient_email,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "task_id": task.id,
        "task_title": task_title,
        "spec_id": spec.id,
        "spec_title": spec_title,
        "spec_content": spec_content or None,
        "spec_type": spec_type,
        "message": message,
        "project_url": project_url,
        "repo_id": repo_id_val,
        "branch": branch,
        "spec_file_path": spec_file_path,
    }, action="send")
    hub_flow_message_id: Optional[str] = (hub_data or {}).get("flow_message_id")
    email_error: Optional[str] = None
    if hub_configured and not hub_flow_message_id:
        email_error = f"Email to {recipient_email} could not be sent — the notification service did not confirm delivery."

    # 5a. Upload .flowmsg bundle to hub so the recipient can materialize the task on their end.
    if hub_flow_message_id and fm:
        try:

            zip_path = await fm.to_file()
            bundle_filename = f"{_meaningful_name(task_title)}.flowmsg"
            content = zip_path.read_bytes()
            await hub_post(
                BuiltinEntityType.FLOW_MESSAGE, {}, hub_flow_message_id, "fs", "upload",
                files={"uploaded_file": (bundle_filename, content, "application/zip")},
            )
            zip_path.unlink(missing_ok=True)
            await hub_put(BuiltinEntityType.FLOW_MESSAGE, hub_flow_message_id, {"attachment_filename": bundle_filename})
        except Exception as _upload_err:
            logger.warning("[notification_action] bundle upload to hub failed (non-fatal): %s", _upload_err)

    # 6. Save Notification locally
    notification = Notification.model_validate({
        "notification_type": NotificationType.RESOURCE_ACTION,
        "notification_target": f"task-@{task.id}",
        "notification_subtype": CrudAction.CREATE,
        "recipient_id": resolved_recipient_id,
        "sender_id": sender_id,
        "delivery_method": DeliveryMethod.EMAIL,
        "notification_status": NotificationStatus.SENT if hub_flow_message_id else NotificationStatus.PENDING,
        "message": message,
        "metadata": {
            "project_url": project_url,
            "spec_id": spec.id,
            "sender_name": sender_name,
        },
    })
    notification.id = hub_flow_message_id or Notification.allocate_id(notification.model_dump())
    notification = await notification.save(someone_typeid)

    # 7. If hub failed, add a bookmark so the user sees it in the activity panel.
    if email_error:
        failure_bookmark = Bookmark.model_validate({
            "bookmark_type": "notification_failed",
            "title": f"Email not sent: {task_title}",
            "content": f"Task was created but the notification email to {recipient_email} could not be confirmed. You may want to follow up manually.",
            "source": "notification",
            "data": {
                "task_id": task.id,
                "recipient_email": recipient_email,
                "task_title": task_title,
                "notification_id": notification.id,
            },
            "status": "open",
        })
        await failure_bookmark.save(someone_typeid)

    base = hub_base_url()
    return ApiSuccessResponse(data={
        "sent": bool(hub_flow_message_id),
        "email_error": email_error,
        "spec_id": spec.id,
        "task_id": task.id,
        "conversation_id": conversation_id,
        "notification_id": notification.id,
        "notify_url": f"{base}/flow_message/{hub_flow_message_id}" if hub_flow_message_id and base else None,
    })


async def handle_append_conversation(body: dict, someone_typeid: str) -> ApiResponse:
    """Append a reply to an existing task's Conversation entity and conversation.jsonl."""
    task_id = (body.get("task_id") or "").strip()
    message = (body.get("message") or "").strip()

    if not task_id:
        return ApiFailResponse(message="task_id is required")
    if not message:
        return ApiFailResponse(message="message is required")

    task = await Task.get_one({"id": task_id})
    if not task:
        return ApiFailResponse(message=f"Task not found: {task_id}")

    local_user = await User.get_one({"uname": "local"})
    sender_id: Optional[str] = local_user.id if local_user else None

    # Find the Conversation entity — try by task_id first, then by task.conversation_id
    conv = await Conversation.get_one({"task_id": task_id})
    if not conv and task.conversation_id:
        conv = await Conversation.get_one({"id": task.conversation_id})
    if not conv:
        return ApiFailResponse(message=f"No conversation found for task {task_id}")

    # Save FlowMessage record for this reply
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.fs_store.type_id import TypeId
    reply_fm = FlowMessage.model_validate({
        "text": message,
        "context": [
            TypeId(type=BuiltinEntityType.TASK.value, id=task_id),
            TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id),
        ],
        "attachment": [],
        "sender_id": sender_id,
    })
    reply_fm.id = FlowMessage.allocate_id(reply_fm.model_dump())
    reply_fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task_id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=reply_fm.id))),
    ]

    # Save any uploaded files to disk and add FILE attachments
    uploaded_files = body.get("files") or []
    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]
    if uploaded_files:
        from flow_sdk.config import FLOW_HOME
        files_dir = FLOW_HOME / "tasks" / f"{_meaningful_name(task.title)}-{task_id[:8]}" / "files"
        files_dir.mkdir(parents=True, exist_ok=True)
        for uf in uploaded_files:
            if not hasattr(uf, "read"):
                continue
            filename = getattr(uf, "filename", None) or "file"
            file_path = files_dir / filename
            content = await uf.read()
            file_path.write_bytes(content)
            reply_fm.attachment.append(
                Attachment(attachment_type=AttachmentType.FILE, data=str(file_path))
            )

    reply_fm = await reply_fm.save(someone_typeid)

    # Upload reply to hub so the original sender can fetch it via inbox
    sender_name: str = (local_user.name or local_user.email or "") if local_user else ""

    # Resolve recipient email: depends on whether I'm the original sender or the recipient.
    # - If I sent the task (shared_by_id == my id): reply goes to the recipient (stored in recipient_email).
    # - If I received the task (shared_by_id != my id): reply goes to the sender (stored in sender_email).
    original_sender_id = task.shared_by_id or ""
    task_meta = task.metadata or {}
    local_user_id_str = local_user.id if local_user else ""
    if original_sender_id and original_sender_id == local_user_id_str:
        # I am the original sender — reply to the recipient
        recipient_email_for_reply = task_meta.get("recipient_email") or ""
    else:
        # I am the recipient — reply to the original sender
        recipient_email_for_reply = task_meta.get("sender_email") or ""
    if recipient_email_for_reply and hub_base_url():
        try:
            import uuid as _uuid
            hub_reply_id = str(_uuid.uuid4())
            logger.warning("[append_conversation][DEBUG] posting to hub: hub_reply_id=%s recipient=%s", hub_reply_id, recipient_email_for_reply)
            hub_data = await hub_post(BuiltinEntityType.FLOW_MESSAGE, {
                "flow_message_id": hub_reply_id,
                "recipient_email": recipient_email_for_reply,
                "sender_id": sender_id,
                "sender_name": sender_name,
                "task_id": task_id,
                "task_title": task.title or "",
                "message": message,
            }, action="send")
            logger.warning("[append_conversation][DEBUG] hub_post(send) response: %s", hub_data)
            hub_reply_fm_id = (hub_data or {}).get("flow_message_id")
            if hub_reply_fm_id:
                zip_path = await reply_fm.to_file()
                bundle_filename = f"reply-{_meaningful_name(task.title or 'reply')}.flowmsg"
                content = zip_path.read_bytes()
                logger.warning("[append_conversation][DEBUG] uploading bundle: hub_reply_fm_id=%s filename=%s size=%d", hub_reply_fm_id, bundle_filename, len(content))
                upload_resp = await hub_post(
                    BuiltinEntityType.FLOW_MESSAGE, {}, hub_reply_fm_id, "fs", "upload",
                    files={"uploaded_file": (bundle_filename, content, "application/zip")},
                )
                logger.warning("[append_conversation][DEBUG] upload response: %s", upload_resp)
                zip_path.unlink(missing_ok=True)
                put_resp = await hub_put(BuiltinEntityType.FLOW_MESSAGE, hub_reply_fm_id, {"attachment_filename": bundle_filename})
                logger.warning("[append_conversation][DEBUG] hub_put(attachment_filename) response: %s", put_resp)
            else:
                logger.warning("[append_conversation][DEBUG] hub_post(send) returned no flow_message_id, hub_data=%s", hub_data)
        except Exception as _hub_err:
            logger.warning("[append_conversation] hub reply upload failed (non-fatal): %s", _hub_err, exc_info=True)

    # Append pointer to conversation + keep message_ids in sync
    reply_ts = datetime.now(UTC).isoformat()
    if conv.data_path:
        from flow_sdk.fs_records.conversation_record import ConversationRecord
        rec = ConversationRecord.from_jsonl(Path(conv.data_path), task_id, conv.id)
        rec.append_message_pointer(reply_fm.id, reply_ts)
    existing_ids_raw: list = []
    if conv.message_ids:
        try:
            existing_ids_raw = _json.loads(conv.message_ids)
        except Exception:
            existing_ids_raw = []
    existing_ids_raw.append({"message_id": reply_fm.id, "timestamp": reply_ts})
    conv.message_ids = _json.dumps(existing_ids_raw)
    conv.message_count = len(existing_ids_raw)
    conv = await conv.save(someone_typeid)

    # Notify UI so conversation refreshes automatically
    try:
        send_resource_sync(
            type="conversation",
            id=conv.id,
            operation=SyncOperation.UPDATE,
            data={"event_data": {"conversation_id": conv.id, "task_id": task_id, "flow_message_id": reply_fm.id}},
        )
    except Exception:
        pass

    # Git push the updated conversation.jsonl
    project_root_str = (task.metadata or {}).get("project_root")
    if project_root_str:
        project_root = Path(project_root_str)
        await git_add_commit_push(
            project_root,
            ["tasks"],
            f"chore: update conversation for task '{task.title}'",
        )

    return ApiSuccessResponse(data={
        "task_id": task_id,
        "conversation_id": conv.id,
        "message_count": conv.message_count,
        "flow_message_id": reply_fm.id,
    })


@action.post(action_name="share_task", types=None)
async def send_notification() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        body = await request_info.get_post_data() or {}
        return await handle_send_notification(body, request_info.someone_typeid)
    except Exception as e:
        logger.error(f"[notification_action] send error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to send notification: {str(e)}")


@action.post(action_name="append-conversation", types=["notification"])
async def append_conversation() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        body = await request_info.get_post_data() or {}
        return await handle_append_conversation(body, request_info.someone_typeid)
    except Exception as e:
        logger.error(f"[notification_action] append-conversation error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to append conversation: {str(e)}")


async def handle_refresh_notifications(project_path: str) -> ApiResponse:
    """Git pull the project repo and run the incoming notification scanner."""
    import asyncio as _asyncio
    project_root = find_project_root(project_path) if project_path else None
    if project_root:
        await git_pull(project_root)
    try:
        from flow_sdk.fs_records.notification_scanner import scan_incoming_notifications
        local_user = await User.get_one({"uname": "local"})
        if local_user:
            await _asyncio.ensure_future(scan_incoming_notifications(local_user.id))
    except Exception as e:
        logger.warning(f"[notification_action] scan error (non-fatal): {e}")
    return ApiSuccessResponse(data={"refreshed": True})


@action.post(action_name="refresh", types=["notification"])
async def refresh_notifications() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        body = await request_info.get_post_data() or {}
        return await handle_refresh_notifications(
            project_path=(body.get("project_path") or "").strip(),
        )
    except Exception as e:
        logger.error(f"[notification_action] refresh error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to refresh: {str(e)}")


@action.get(action_name="open", types=["notification"])
async def open_notification() -> ApiResponse:
    """Deep-link handler: fetch notification from hub, redirect to UI dialog."""
    from flow_sdk.server.routes.notify import handle_notification_deep_link

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found", status_code=400)

    notification_id = str(request_info.target_entity_typeid.id)
    data = await hub_get(BuiltinEntityType.NOTIFICATION, notification_id)

    meta = data.get("metadata") or {} if data else {}
    return await handle_notification_deep_link(
        project_url=(meta.get("project_url") or (data or {}).get("project_url") or "").strip(),
        task_id=(meta.get("task_id") or (data or {}).get("task_id") or "").strip(),
        branch=(meta.get("branch") or (data or {}).get("branch") or "").strip(),
        repo_id=(meta.get("repo_id") or (data or {}).get("repo_id") or "").strip(),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        task_title=(meta.get("task_title") or (data or {}).get("task_title") or "").strip(),
    )
