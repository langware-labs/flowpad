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


async def _resolve_recipient(recipient_id: str) -> tuple[Optional[str], str]:
    """Return (recipient_email, resolved_recipient_id) or raise ValueError."""
    recipient_user = await User.get_one({"id": recipient_id})
    if not recipient_user:
        recipient_user = await User.get_one({"email": recipient_id})

    if recipient_user:
        return recipient_user.email, recipient_user.id
    if "@" in recipient_id:
        recipient_user = await User.get_or_create_by_email(recipient_id)
        return recipient_user.email, recipient_user.id
    raise ValueError(f"Recipient not found: {recipient_id}")


async def _create_spec_and_task(
    *,
    spec_title: str,
    spec_content: str,
    spec_type: str,
    plan_id: Optional[str],
    task_title: str,
    sender_id: Optional[str],
    sender_name: str,
    sender_email: str,
    recipient_email: Optional[str],
    team_space_id: Optional[str],
    someone_typeid: str,
) -> tuple[Spec, Task]:
    """Create Spec + Task entities locally and register the task on the hub."""
    spec = Spec.model_validate({
        "title": spec_title,
        "content": spec_content,
        "spec_type": spec_type,
        "plan_id": plan_id,
        "author_id": sender_id,
    })
    spec.id = Spec.allocate_id(spec.model_dump())
    spec = await spec.save(someone_typeid)

    task_meta: dict = {
        "sender_name": sender_name,
        "sender_email": sender_email,
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

    # Register task on hub so the recipient can load it via the hub graph API.
    await hub_post(BuiltinEntityType.TASK, {
        "id": task.id,
        "title": task_title,
        "task_type": task.task_type,
        "status": task.status,
    })

    return spec, task


async def _create_conversation_and_fm(
    *,
    spec: Spec,
    task: Task,
    task_dir: Path,
    sender_id: Optional[str],
    sender_name: str,
    recipient_email: Optional[str],
    message: Optional[str],
    someone_typeid: str,
) -> tuple[Conversation, "FlowMessage"]:
    """Create Conversation + FlowMessage entities for a task directory.

    Shared by both the git path (_write_task_to_git) and the no-git path
    (_create_local_conversation_and_fm). task_dir must already exist.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.fs_records.conversation_record import ConversationRecord
    from flow_sdk.fs_store.type_id import TypeId

    conv = await _create_conversation_entity(task, task_dir / "conversation.jsonl", someone_typeid)
    task.conversation_id = conv.id
    task = await task.save(someone_typeid)

    fm_context = [
        TypeId(type=BuiltinEntityType.TASK.value, id=task.id),
        TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id),
    ]
    fm = FlowMessage.model_validate({
        "text": message or f"Task shared: {task.title}",
        "context": fm_context,
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "receiver_address": recipient_email,
        "receiver_address_type": "email",
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

    fm_ts = datetime.now(UTC).isoformat()
    if conv.data_path:
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

    return conv, fm


async def _write_task_to_git(
    *,
    project_root: Path,
    spec: Spec,
    task: Task,
    spec_title: str,
    spec_type: str,
    task_title: str,
    plan_id: Optional[str],
    sender_id: Optional[str],
    sender_name: str,
    recipient_email: Optional[str],
    message: Optional[str],
    repo_id_val: str,
    someone_typeid: str,
) -> tuple[Conversation, "FlowMessage", str, str]:
    """Write spec.md, manifest.json, conversation.jsonl; create Conversation + FlowMessage.

    Returns (conv, fm, spec_file_path, branch_at_write).
    """
    tasks_root = Path(project_root) / "tasks"
    spec_root = tasks_root / "spec"

    spec_dir_name = _unique_dir_name(_meaningful_name(spec_title), spec_root)
    task_dir_name = _unique_dir_name(_meaningful_name(task_title), tasks_root)

    spec_file_path = f"tasks/spec/{spec_dir_name}/spec.md"

    spec_dir = spec_root / spec_dir_name
    spec_dir.mkdir(parents=True, exist_ok=True)
    (spec_dir / "spec.md").write_text(
        f"---\ntitle: \"{spec_title}\"\nspec_type: {spec_type}\n"
        f"spec_id: {spec.id}\nauthor_id: {sender_id or ''}\nplan_id: {plan_id or ''}\n---\n\n{spec.content}",
        encoding="utf-8",
    )

    task_dir = tasks_root / task_dir_name
    task_dir.mkdir(parents=True, exist_ok=True)

    conv, fm = await _create_conversation_and_fm(
        spec=spec,
        task=task,
        task_dir=task_dir,
        sender_id=sender_id,
        sender_name=sender_name,
        recipient_email=recipient_email,
        message=message,
        someone_typeid=someone_typeid,
    )

    branch_at_write = git_current_branch(project_root)
    (task_dir / "manifest.json").write_text(
        _json.dumps({
            "task_id": task.id,
            "title": task_title,
            "spec_id": spec.id,
            "spec_dir": spec_dir_name,
            "shared_by_id": sender_id,
            "sender_name": sender_name,
            "conversation_id": conv.id,
            "created_at": datetime.now(UTC).isoformat(),
            "repo_id": repo_id_val,
            "branch": branch_at_write,
        }, indent=2, default=str),
        encoding="utf-8",
    )

    return conv, fm, spec_file_path, branch_at_write


async def _create_local_conversation_and_fm(
    *,
    spec: Spec,
    task: Task,
    task_title: str,
    sender_id: Optional[str],
    sender_name: str,
    recipient_email: Optional[str],
    message: Optional[str],
    someone_typeid: str,
) -> tuple[Conversation, "FlowMessage"]:
    """Create Conversation + FlowMessage locally without git.

    Used when there is no project_root — ensures a .flowmsg bundle can still
    be packed and uploaded to the hub so the recipient can materialise the task.
    """
    from flow_sdk.instance_settings import get_instance_settings

    task_dir = get_instance_settings().tasks_dir / f"{_meaningful_name(task_title)}-{task.id[:8]}"
    task_dir.mkdir(parents=True, exist_ok=True)

    return await _create_conversation_and_fm(
        spec=spec,
        task=task,
        task_dir=task_dir,
        sender_id=sender_id,
        sender_name=sender_name,
        recipient_email=recipient_email,
        message=message,
        someone_typeid=someone_typeid,
    )


async def _push_task_changes(project_root: Path, task_title: str) -> Optional[str]:
    """Git add/commit/push the tasks directory. Returns an error string on failure, else None."""
    push_result = await git_add_commit_push(project_root, ["tasks"], f"chore: share task '{task_title}'")
    if not push_result.ok and push_result.message and "Nothing to commit" not in push_result.message:
        return push_result.message
    if push_result.warning:
        return push_result.warning
    return None


async def _send_hub_notification(
    *,
    recipient_email: Optional[str],
    sender_id: Optional[str],
    sender_name: str,
    task: Task,
    spec: Spec,
    message: Optional[str],
    project_url: str,
    repo_id_val: str,
    branch: str,
    spec_file_path: str,
    fm: Optional["FlowMessage"],
    task_title: str,
) -> tuple[Optional[str], Optional[str]]:
    """POST notification to hub and upload the .flowmsg bundle.

    Returns (hub_flow_message_id, email_error).
    """
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
        "spec_title": spec.title,
        "spec_content": spec.content or None,
        "spec_type": spec.spec_type,
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

    if hub_flow_message_id and fm:
        await _upload_bundle_to_hub(hub_flow_message_id, fm, task_title)

    return hub_flow_message_id, email_error


async def _upload_bundle_to_hub(hub_flow_message_id: str, fm: "FlowMessage", task_title: str) -> None:
    """Pack and upload the .flowmsg bundle to the hub (best-effort, non-fatal)."""
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


async def _save_local_notification(
    *,
    task: Task,
    resolved_recipient_id: str,
    sender_id: Optional[str],
    sender_name: str,
    project_url: str,
    message: Optional[str],
    hub_flow_message_id: Optional[str],
    someone_typeid: str,
) -> Notification:
    """Create and save a local Notification entity."""
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
            "spec_id": task.spec_id,
            "sender_name": sender_name,
        },
    })
    notification.id = hub_flow_message_id or Notification.allocate_id(notification.model_dump())
    return await notification.save(someone_typeid)


async def _save_failure_bookmark(
    *,
    task_id: str,
    task_title: str,
    recipient_email: Optional[str],
    notification_id: str,
    someone_typeid: str,
) -> None:
    """Save a bookmark so the user sees the delivery failure in the activity panel."""
    failure_bookmark = Bookmark.model_validate({
        "bookmark_type": "notification_failed",
        "title": f"Email not sent: {task_title}",
        "content": f"Task was created but the notification email to {recipient_email} could not be confirmed. You may want to follow up manually.",
        "source": "notification",
        "data": {
            "task_id": task_id,
            "recipient_email": recipient_email,
            "task_title": task_title,
            "notification_id": notification_id,
        },
        "status": "open",
    })
    await failure_bookmark.save(someone_typeid)


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

    try:
        recipient_email, resolved_recipient_id = await _resolve_recipient(recipient_id)
    except ValueError as e:
        return ApiFailResponse(message=str(e))

    local_user = await User.get_one({"uname": "local"})
    sender_id: Optional[str] = local_user.id if local_user else None
    body_sender_name = (body.get("sender_name") or "").strip()
    sender_name: str = body_sender_name or ((local_user.name or local_user.email or "") if local_user else "")
    sender_email: str = (local_user.email or "") if local_user else ""

    project_root = find_project_root(project_path) if project_path else None
    project_url = git_remote_url(project_root) if project_root else ""
    repo_full_name = git_repo_full_name(project_root) if project_root else ""
    repo_id_val = repo_id(repo_full_name) if repo_full_name else ""

    spec, task = await _create_spec_and_task(
        spec_title=spec_title,
        spec_content=spec_content,
        spec_type=spec_type,
        plan_id=plan_id,
        task_title=task_title,
        sender_id=sender_id,
        sender_name=sender_name,
        sender_email=sender_email,
        recipient_email=recipient_email,
        team_space_id=team_space_id,
        someone_typeid=someone_typeid,
    )

    uploaded_files = body.get("files") or []
    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]

    conv: Optional[Conversation] = None
    fm = None
    spec_file_path = ""
    branch = ""
    if project_root:
        conv, fm, spec_file_path, branch = await _write_task_to_git(
            project_root=project_root,
            spec=spec,
            task=task,
            spec_title=spec_title,
            spec_type=spec_type,
            task_title=task_title,
            plan_id=plan_id,
            sender_id=sender_id,
            sender_name=sender_name,
            recipient_email=recipient_email,
            message=message,
            repo_id_val=repo_id_val,
            someone_typeid=someone_typeid,
        )

        git_error = await _push_task_changes(project_root, task_title)
        if git_error:
            return ApiSuccessResponse(data={"sent": False, "git_error": git_error})

        branch = git_current_branch(project_root)
    else:
        # No git project — create Conversation + FlowMessage locally so the
        # .flowmsg bundle can be packed and uploaded to the hub. Without this
        # the recipient has no bundle to materialise and gets a 404 on the task.
        conv, fm = await _create_local_conversation_and_fm(
            spec=spec,
            task=task,
            task_title=task_title,
            sender_id=sender_id,
            sender_name=sender_name,
            recipient_email=recipient_email,
            message=message,
            someone_typeid=someone_typeid,
        )

    # Attach uploaded files to the FlowMessage (stored in entity VFS, included in bundle)
    if uploaded_files and fm:
        await _attach_uploaded_files(fm, uploaded_files)
        fm = await fm.save(someone_typeid)

    hub_flow_message_id, email_error = await _send_hub_notification(
        recipient_email=recipient_email,
        sender_id=sender_id,
        sender_name=sender_name,
        task=task,
        spec=spec,
        message=message,
        project_url=project_url,
        repo_id_val=repo_id_val,
        branch=branch,
        spec_file_path=spec_file_path,
        fm=fm,
        task_title=task_title,
    )

    notification = await _save_local_notification(
        task=task,
        resolved_recipient_id=resolved_recipient_id,
        sender_id=sender_id,
        sender_name=sender_name,
        project_url=project_url,
        message=message,
        hub_flow_message_id=hub_flow_message_id,
        someone_typeid=someone_typeid,
    )

    if email_error:
        await _save_failure_bookmark(
            task_id=task.id,
            task_title=task_title,
            recipient_email=recipient_email,
            notification_id=notification.id,
            someone_typeid=someone_typeid,
        )

    base = hub_base_url()
    return ApiSuccessResponse(data={
        "sent": bool(hub_flow_message_id),
        "email_error": email_error,
        "spec_id": spec.id,
        "task_id": task.id,
        "conversation_id": conv.id if conv else None,
        "notification_id": notification.id,
        "notify_url": f"{base}/flow_message/{hub_flow_message_id}" if hub_flow_message_id and base else None,
    })


async def _find_task_conversation(task: Task) -> Optional[Conversation]:
    """Look up the Conversation for a task — by task_id first, then by task.conversation_id."""
    conv = await Conversation.get_one({"task_id": task.id})
    if not conv and task.conversation_id:
        conv = await Conversation.get_one({"id": task.conversation_id})
    return conv


def _build_reply_flow_message(
    *,
    task_id: str,
    conv_id: str,
    message: str,
    sender_id: Optional[str],
    sender_name: str,
) -> "FlowMessage":
    """Build (but do not save) the FlowMessage entity for a conversation reply.

    The caller is responsible for attaching any uploaded files and then saving.
    Building before saving means there is only ever one save, so the frontend
    entity cache always receives the final version with FILE attachments included.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.fs_store.type_id import TypeId

    reply_fm = FlowMessage.model_validate({
        "text": message,
        "context": [
            TypeId(type=BuiltinEntityType.TASK.value, id=task_id),
            TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv_id),
        ],
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "conversation_id": conv_id,
    })
    reply_fm.id = FlowMessage.allocate_id(reply_fm.model_dump())
    reply_fm.attachment = [
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task_id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv_id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=reply_fm.id))),
    ]
    return reply_fm


async def _attach_uploaded_files(reply_fm: "FlowMessage", uploaded_files: list) -> None:
    """Save uploaded files into the FlowMessage entity's VFS storage and append FILE attachments.

    Files are stored at data/{filename} within the entity's embedded storage root so they can
    be served via GET /api/v1/graph/flow_message/{id}/fs/download/data/{filename}.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType
    from flow_sdk.storage import get_entity_embedded_storage

    fm_typeid = reply_fm.typeid
    storage = get_entity_embedded_storage(fm_typeid)
    new_attachments: list = list(reply_fm.attachment or [])
    added_any = False
    for uf in uploaded_files:
        if not hasattr(uf, "read"):
            continue
        filename = getattr(uf, "filename", None) or "file"
        vfs_subpath = f"data/{filename}"
        local_path = Path(storage.get_storage_path(vfs_subpath))
        local_path.parent.mkdir(parents=True, exist_ok=True)
        content = await uf.read()
        local_path.write_bytes(content)
        new_attachments.append(Attachment(attachment_type=AttachmentType.FILE, data=vfs_subpath))
        added_any = True
    if added_any:
        # Assign (not append) so __setattr__ runs and _dirty is set — required because
        # for the original-send path the entity has already been saved once and
        # in-place list mutation doesn't reach the entity's dirty flag.
        reply_fm.attachment = new_attachments


async def _append_message_to_conversation(
    *,
    conv: Conversation,
    task_id: str,
    fm_id: str,
    someone_typeid: str,
) -> Conversation:
    """Write pointer to conversation.jsonl and update message_ids / message_count on the entity."""
    from flow_sdk.fs_records.conversation_record import ConversationRecord

    reply_ts = datetime.now(UTC).isoformat()
    if conv.data_path:
        rec = ConversationRecord.from_jsonl(Path(conv.data_path), task_id, conv.id)
        rec.append_message_pointer(fm_id, reply_ts)
    existing_ids: list = []
    if conv.message_ids:
        try:
            existing_ids = _json.loads(conv.message_ids)
        except Exception:
            existing_ids = []
    existing_ids.append({"message_id": fm_id, "timestamp": reply_ts})
    conv.message_ids = _json.dumps(existing_ids)
    conv.message_count = len(existing_ids)
    return await conv.save(someone_typeid)


def _resolve_reply_recipient_email(task: Task, local_user_id: str) -> str:
    """Return the email address the reply should be delivered to.

    Direction: if I am the original sender → deliver to recipient; otherwise → deliver to sender.
    """
    task_meta = task.metadata or {}
    if task.shared_by_id and task.shared_by_id == local_user_id:
        return task_meta.get("recipient_email") or ""
    return task_meta.get("sender_email") or ""


async def _send_reply_to_hub(
    *,
    reply_fm: "FlowMessage",
    task: Task,
    task_id: str,
    message: str,
    sender_id: Optional[str],
    sender_name: str,
    recipient_email: str,
) -> None:
    """POST the reply notification to hub and upload the .flowmsg bundle (best-effort)."""
    if not recipient_email or not hub_base_url():
        return
    try:
        hub_reply_id = str(uuid.uuid4())
        hub_data = await hub_post(BuiltinEntityType.FLOW_MESSAGE, {
            "flow_message_id": hub_reply_id,
            "recipient_email": recipient_email,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "task_id": task_id,
            "task_title": task.title or "",
            "message": message,
        }, action="send")
        hub_reply_fm_id = (hub_data or {}).get("flow_message_id")
        if hub_reply_fm_id:
            await _upload_bundle_to_hub(hub_reply_fm_id, reply_fm, f"reply-{task.title or 'reply'}")
        else:
            logger.warning("[append_conversation] hub_post(send) returned no flow_message_id")
    except Exception as _hub_err:
        logger.warning("[append_conversation] hub reply upload failed (non-fatal): %s", _hub_err, exc_info=True)


def _notify_ui_conversation_updated(conv_id: str, task_id: str, fm_id: str) -> None:
    """Fire-and-forget sync event so the UI refreshes the conversation panel."""
    try:
        send_resource_sync(
            type="conversation",
            id=conv_id,
            operation=SyncOperation.UPDATE,
            data={"event_data": {"conversation_id": conv_id, "task_id": task_id, "flow_message_id": fm_id}},
        )
    except Exception:
        pass


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

    conv = await _find_task_conversation(task)
    if not conv:
        return ApiFailResponse(message=f"No conversation found for task {task_id}")

    local_user = await User.get_one({"uname": "local"})
    sender_id: Optional[str] = local_user.id if local_user else None
    body_sender_name = (body.get("sender_name") or "").strip()
    sender_name: str = body_sender_name or ((local_user.name or local_user.email or "") if local_user else "")

    reply_fm = _build_reply_flow_message(
        task_id=task_id,
        conv_id=conv.id,
        message=message,
        sender_id=sender_id,
        sender_name=sender_name,
    )

    uploaded_files = body.get("files") or []
    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]
    if uploaded_files:
        await _attach_uploaded_files(reply_fm, uploaded_files)
    reply_fm = await reply_fm.save(someone_typeid)

    # Append pointer BEFORE packing the bundle so conversation.jsonl is up-to-date in the zip
    conv = await _append_message_to_conversation(
        conv=conv,
        task_id=task_id,
        fm_id=reply_fm.id,
        someone_typeid=someone_typeid,
    )

    recipient_email = _resolve_reply_recipient_email(task, local_user.id if local_user else "")
    await _send_reply_to_hub(
        reply_fm=reply_fm,
        task=task,
        task_id=task_id,
        message=message,
        sender_id=sender_id,
        sender_name=sender_name,
        recipient_email=recipient_email,
    )

    _notify_ui_conversation_updated(conv.id, task_id, reply_fm.id)

    project_root_str = (task.metadata or {}).get("project_root")
    if project_root_str:
        await git_add_commit_push(
            Path(project_root_str),
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


@action.post(action_name="update-local-user-name", types=None)
async def update_local_user_name() -> ApiResponse:
    """Update the local user's display name."""
    request_info = get_current_request_info()
    if not request_info:
        return ApiFailResponse(message="No request info found")
    body = await request_info.get_post_data() or {}
    new_name = (body.get("name") or "").strip()
    if not new_name:
        return ApiFailResponse(message="name is required")
    local_user = await User.get_one({"uname": "local"})
    if not local_user:
        return ApiFailResponse(message="Local user not found")
    local_user.name = new_name
    await local_user.save()
    return ApiSuccessResponse(data={"name": new_name})


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
