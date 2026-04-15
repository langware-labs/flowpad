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
  POST /api/v1/graph/notification/append-conversation
  POST /api/v1/graph/notification/open-task
"""

import asyncio
import json as _json
import logging
import re
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
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk.utils.git import find_local_repo_for_url, find_project_root, git_add_commit_push, git_current_branch, git_pull, git_remote_url
from flow_sdk.utils.hub import hub_base_url, hub_post
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
    initial_messages: list[dict],
    someone_typeid: str,
) -> Conversation:
    """Create a Conversation entity + write initial messages to conversation.jsonl.

    Attaches the conversation as a child of the task in the DB.
    """
    from flow_sdk.fs_records.conversation_record import ConversationRecord

    # Write messages to jsonl
    conversation_jsonl_path.parent.mkdir(parents=True, exist_ok=True)
    if initial_messages:
        with conversation_jsonl_path.open("w", encoding="utf-8") as fh:
            for msg in initial_messages:
                fh.write(_json.dumps(msg, ensure_ascii=False) + "\n")
    else:
        conversation_jsonl_path.touch()

    messages_json = _json.dumps(initial_messages) if initial_messages else None

    conv = Conversation.model_validate({
        "task_id": task.id,
        "data_path": str(conversation_jsonl_path),
        "message_count": len(initial_messages),
        "messages": messages_json,
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
    task = Task.model_validate({
        "title": task_title,
        "spec_id": spec.id,
        "shared_by_id": sender_id,
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)

    # 2a. Register task on hub so the recipient can load it via the hub graph API.
    # The hub's generic create endpoint stores it in Neo4j with owner access for the sender.
    await hub_post("task", {
        "id": task.id,
        "title": task_title,
        "task_type": task.task_type,
        "status": task.status,
    })

    # 3. Write spec + manifest + conversation.jsonl to git repo
    conversation_id: Optional[str] = None
    spec_file_path = ""
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

        # 3a. Create Conversation entity + conversation.jsonl
        initial_messages = []
        if message:
            initial_messages = [{
                "role": "sender",
                "content": message,
                "sender_id": sender_id or "",
                "timestamp": datetime.now(UTC).isoformat(),
            }]
        conv = await _create_conversation_entity(
            task,
            task_dir / "conversation.jsonl",
            initial_messages,
            someone_typeid,
        )
        conversation_id = conv.id

        # Update task with conversation_id
        task.conversation_id = conversation_id
        task = await task.save(someone_typeid)

        # 3b. Write manifest
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
    hub_data = await hub_post("notify_hub", {
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
        "branch": branch,
        "spec_file_path": spec_file_path,
    })
    hub_notification_id: Optional[str] = (hub_data or {}).get("notification_id")
    email_error: Optional[str] = None
    if hub_configured and not hub_notification_id:
        email_error = f"Email to {recipient_email} could not be sent — the notification service did not confirm delivery."

    # 6. Save Notification locally
    notification = Notification.model_validate({
        "notification_type": NotificationType.RESOURCE_ACTION,
        "notification_target": f"task-@{task.id}",
        "notification_subtype": CrudAction.CREATE,
        "recipient_id": resolved_recipient_id,
        "sender_id": sender_id,
        "delivery_method": DeliveryMethod.EMAIL,
        "notification_status": NotificationStatus.SENT if hub_notification_id else NotificationStatus.PENDING,
        "message": message,
        "metadata": {
            "project_url": project_url,
            "spec_id": spec.id,
            "sender_name": sender_name,
        },
    })
    notification.id = hub_notification_id or Notification.allocate_id(notification.model_dump())
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
        "sent": bool(hub_notification_id),
        "email_error": email_error,
        "spec_id": spec.id,
        "task_id": task.id,
        "conversation_id": conversation_id,
        "notification_id": notification.id,
        "notify_url": f"{base}/notify/{notification.id}" if hub_notification_id and base else None,
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

    # Find the Conversation entity (child of this task)
    conv = await Conversation.get_one({"task_id": task_id})
    if not conv:
        return ApiFailResponse(message=f"No conversation found for task {task_id}")

    new_msg = {
        "role": "recipient",
        "content": message,
        "sender_id": sender_id or "",
        "timestamp": datetime.now(UTC).isoformat(),
    }

    # Append to conversation.jsonl
    if conv.data_path:
        from flow_sdk.fs_records.conversation_record import ConversationRecord
        rec = ConversationRecord.from_jsonl(Path(conv.data_path), task_id, conv.id)
        rec.append_message(new_msg)

    # Update the Conversation entity
    existing_msgs: list = []
    if conv.messages:
        try:
            existing_msgs = _json.loads(conv.messages)
        except Exception:
            existing_msgs = []
    existing_msgs.append(new_msg)
    conv.messages = _json.dumps(existing_msgs)
    conv.message_count = len(existing_msgs)
    conv = await conv.save(someone_typeid)

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
    })


async def handle_open_task(project_url: str, task_id: str) -> ApiResponse:
    """Git pull + scan then return the navigation path for the task."""
    if not project_url:
        return ApiFailResponse(message="project_url is required")
    if not find_local_repo_for_url(project_url):
        return ApiFailResponse(message=f"No local clone found for {project_url}")

    repo_path = find_local_repo_for_url(project_url)
    pull_ok, pull_msg = await git_pull(repo_path)
    git_error: Optional[str] = None if pull_ok else pull_msg

    try:
        from flow_sdk.fs_records.notification_scanner import scan_incoming_notifications
        local_user = await User.get_one({"uname": "local"})
        if local_user:
            asyncio.ensure_future(scan_incoming_notifications(local_user.id))
    except Exception:
        pass

    nav_path = f"/dock/tasks/task-{task_id}" if task_id else "/dock/tasks"
    return ApiSuccessResponse(data={"navigation_path": nav_path, "git_error": git_error})


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


@action.post(action_name="open-task", types=["notification"])
async def open_task_notification() -> ApiResponse:
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        body = await request_info.get_post_data() or {}
        return await handle_open_task(
            project_url=(body.get("project_url") or "").strip(),
            task_id=(body.get("task_id") or "").strip(),
        )
    except Exception as e:
        logger.error(f"[notification_action] open-task error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to open task: {str(e)}")


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
