"""Action handler for sending cross-user notifications.

Sender flow:
  1. Create Spec + Task entities in local DB
  2. Write spec.md and task manifest to git repo under tasks/
  3. Git push
  4. POST notification to Flowpad Hub (which stores it and emails recipient)

File layout (all inside the git repo, committed and pushed):
  tasks/<task-title>/manifest.json          — task metadata for scanner
  tasks/spec/<spec-title>/spec.md           — spec content (markdown + frontmatter)

Routes:
  POST /api/v1/graph/cross_notification/send
  POST /api/v1/graph/cross_notification/open-task
"""

import asyncio
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from flow_sdk._compat import UTC
from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.cross_notification import (
    CrossUserNotification,
    CrudAction,
    DeliveryMethod,
    NotificationStatus,
)
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk.utils.git import find_local_repo_for_url, find_project_root, git_add_commit_push, git_remote_url
from flow_sdk.utils.hub import hub_post

logger = logging.getLogger(__name__)


def _unique_dir_name(base_name: str, parent: Path) -> str:
    """Return a directory name that doesn't already exist under parent.

    Appends a counter (2, 3, …) if the name is already taken.
    """
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




async def handle_send_notification(body: dict, someone_typeid: str) -> ApiResponse:
    """Create Spec + Task, write to git repo, push, post to hub."""
    import json as _json

    recipient_id = (body.get("recipient_id") or "").strip()
    spec_title = (body.get("spec_title") or "").strip()
    spec_content = (body.get("spec_content") or "").strip()
    spec_type = (body.get("spec_type") or "plan").strip()
    task_title = (body.get("task_title") or spec_title).strip()
    message = (body.get("message") or "").strip() or None
    plan_id = (body.get("plan_id") or "").strip() or None

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

    project_root = find_project_root(plan_id) if plan_id else None
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

    # 2. Create Task entity
    initial_conversation = None
    if message:
        initial_conversation = _json.dumps([{
            "role": "sender",
            "content": message,
            "sender_id": sender_id or "",
            "timestamp": datetime.now(UTC).isoformat(),
        }])
    task = Task.model_validate({
        "title": task_title,
        "spec_id": spec.id,
        "shared_by_id": sender_id,
        "conversation": initial_conversation,
    })
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)

    # 3. Write spec + manifest to git repo
    if project_root:
        tasks_root = Path(project_root) / "tasks"
        spec_root = tasks_root / "spec"

        spec_dir_name = _unique_dir_name(_meaningful_name(spec_title), spec_root)
        task_dir_name = _unique_dir_name(_meaningful_name(task_title), tasks_root)

        spec_dir = spec_root / spec_dir_name
        spec_dir.mkdir(parents=True, exist_ok=True)
        (spec_dir / "spec.md").write_text(
            f"---\ntitle: \"{spec_title}\"\nspec_type: {spec_type}\n"
            f"spec_id: {spec.id}\nauthor_id: {sender_id or ''}\nplan_id: {plan_id or ''}\n---\n\n{spec_content}",
            encoding="utf-8",
        )

        task_dir = tasks_root / task_dir_name
        task_dir.mkdir(parents=True, exist_ok=True)
        (task_dir / "manifest.json").write_text(
            _json.dumps({
                "task_id": task.id,
                "title": task_title,
                "spec_id": spec.id,
                "spec_dir": spec_dir_name,
                "shared_by_id": sender_id,
                "sender_name": sender_name,
                "created_at": datetime.now(UTC).isoformat(),
            }, indent=2, default=str),
            encoding="utf-8",
        )

    # 4. Git push (fire-and-forget)
    if project_root:
        asyncio.ensure_future(
            git_add_commit_push(project_root, ["tasks"], f"chore: share task '{task_title}'")
        )

    # 5. Post to hub
    hub_data = await hub_post("cross_notification/send", {
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
    })
    hub_notification_id: Optional[str] = (hub_data or {}).get("notification_id")

    # 6. Save CrossUserNotification locally
    notification = CrossUserNotification.model_validate({
        "recipient_id": resolved_recipient_id,
        "sender_id": sender_id,
        "project_url": project_url,
        "spec_id": spec.id,
        "target_id": task.id,
        "action": CrudAction.CREATE,
        "status": NotificationStatus.SENT if hub_notification_id else NotificationStatus.PENDING,
        "message": message,
        "delivery_method": DeliveryMethod.EMAIL,
    })
    notification.id = hub_notification_id or CrossUserNotification.allocate_id(notification.model_dump())
    notification.sent_at = datetime.now(UTC)
    notification = await notification.save(someone_typeid)

    from flow_sdk.utils.hub import hub_base_url
    base = hub_base_url()
    return ApiSuccessResponse(data={
        "sent": bool(hub_notification_id),
        "spec_id": spec.id,
        "task_id": task.id,
        "notification_id": notification.id,
        "notify_url": f"{base}/notify/{notification.id}" if hub_notification_id and base else None,
    })


async def handle_open_task(project_url: str, task_id: str) -> ApiResponse:
    """Git pull + scan then return the navigation path for the task."""
    if not project_url:
        return ApiFailResponse(message="project_url is required")
    if not find_local_repo_for_url(project_url):
        return ApiFailResponse(message=f"No local clone found for {project_url}")

    repo_path = find_local_repo_for_url(project_url)
    await git_pull(repo_path)
    try:
        from flow_sdk.fs_records.cross_notification_scanner import scan_incoming_notifications
        local_user = await User.get_one({"uname": "local"})
        if local_user:
            asyncio.ensure_future(scan_incoming_notifications(local_user.id))
    except Exception:
        pass

    nav_path = f"/dock/tasks/task-{task_id}" if task_id else "/dock/tasks"
    return ApiSuccessResponse(data={"navigation_path": nav_path})


@action.post(action_name="send", types=["cross_notification"])
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


@action.post(action_name="open-task", types=["cross_notification"])
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
