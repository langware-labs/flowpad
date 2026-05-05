"""Action handler for sending cross-user notifications.

Sender flow:
  1. Create Spec + Task + Conversation entities in local DB
  2. Write spec.md, task manifest, and conversation.jsonl to git repo under tasks/
  3. Git push
  4. POST notification to Flowpad Hub (which stores it and emails recipient)

File layout (all inside the git repo, committed and pushed):
  tasks/<task-title>/header.json            — task metadata for scanner
  tasks/<task-title>/conversation.jsonl     — typed Pointer per line
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
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.fs_store import SyncOperation
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse
from flow_sdk.utils.git import find_project_root, git_add_commit_push, git_current_branch, git_pull, git_remote_url, git_repo_full_name, repo_id
from flow_sdk.utils.hub import HubError, hub_base_url, hub_get, hub_post, hub_put
from flow_sdk.builtin.bookmark import Bookmark

logger = logging.getLogger(__name__)

PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT = "Please run the following prompt:"


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


async def _resolve_local_project_identity(
    project_root: Optional[Path],
) -> tuple[Optional[str], Optional[str]]:
    """Look up the local Project entity matching `project_root` and return (id, name).

    Returns (None, None) when there is no project_root or no matching Project.
    The project's uuid `id` becomes the cross-user `project_id` carried in
    header.json and the hub payload, so the recipient can map it locally.
    """
    if not project_root:
        return None, None
    try:
        from flow_sdk.builtin.project import Project
        proj = await Project.get_one({"fs_storage_mount_path": str(project_root)})
        if proj:
            return (proj.id or None), (proj.name or Path(project_root).name)
    except Exception as e:
        logger.warning("[notification_action] _resolve_local_project_identity failed: %s", e)
    return None, Path(project_root).name


async def _create_conversation_entity(
    task: Task,
    conversation_jsonl_path: Path,
    someone_typeid: str,
) -> Conversation:
    """Create an empty Conversation entity + canonical conversation.jsonl.

    ``conversation_jsonl_path`` is preserved as a parameter for callsite
    back-compat but the canonical location is always
    ``ConversationRecord.default_jsonl_path(conv.id)``. Funnels through
    ``ensure_conversation_entity`` so sender and recipient paths share one
    creation routine.
    """
    from flow_sdk.app.actions.materialize_flow_message import ensure_conversation_entity
    from flow_sdk.fs_store.type_id import TypeId

    task_typeid = TypeId(type=BuiltinEntityType.TASK.value, id=task.id)
    conv_id = Conversation.allocate_id({"context_entities": [str(task_typeid)]})
    conv = await ensure_conversation_entity(
        conv_id, parent_typeid=task_typeid, someone_typeid=someone_typeid
    )
    await task.attach_child(conv)
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
    project_id: Optional[str] = None,
    project_name: Optional[str] = None,
    project_root: Optional[str] = None,
    sender_process_id: Optional[str] = None,
    forked_process_id: Optional[str] = None,
) -> tuple[Optional[Spec], Task]:
    """Create Task (and optionally Spec) entities locally and register the task on the hub.

    The Spec is skipped when both `spec_title` and `spec_content` are blank
    — used by the "I need help" flow where the recipient drives the task with
    a PROMPT reply rather than a written specification.
    """
    spec: Optional[Spec] = None
    spec_id: Optional[str] = None
    if spec_title or spec_content:
        spec_payload: dict = {
            "title": spec_title,
            "content": spec_content,
            "spec_type": spec_type,
            "author_id": sender_id,
        }
        if plan_id:
            # plan_id consolidated into ``context_entities``.
            spec_payload["context_entities"] = [f"plan-{plan_id}"]
        spec = Spec.model_validate(spec_payload)
        spec.id = Spec.allocate_id(spec.model_dump())
        spec = await spec.save(someone_typeid)
        spec_id = spec.id

    task_payload: dict = {
        "title": task_title,
        "shared_by_id": sender_id,
        "sender_name": sender_name,
        "sender_email": sender_email,
        "recipient_email": recipient_email or "",
        "team_space_id": team_space_id or None,
        "project_name": project_name or None,
        "project_root": project_root or None,
        "project_id": project_id,
        "spec_type": spec_type,
        "my_process_id": sender_process_id,
        "shared_process_id": forked_process_id,
    }
    if spec_id:
        # spec_id consolidated into ``context_entities``.
        task_payload["context_entities"] = [f"spec-{spec_id}"]
    task = Task.model_validate(task_payload)
    task.id = Task.allocate_id(task.model_dump())
    task = await task.save(someone_typeid)
    if forked_process_id:
        try:
            from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
            fork = await AgenticProcess.get_one({"id": forked_process_id})
            if fork is not None:
                task_vfs = str(TypeId(type=BuiltinEntityType.TASK.value, id=task.id))
                dirty = False
                if fork.target_vfs_path != task_vfs:
                    fork.target_vfs_path = task_vfs
                    dirty = True
                if not fork.project_id and project_id:
                    fork.project_id = project_id
                    dirty = True
                if not fork.workdir and project_root:
                    fork.workdir = project_root
                    dirty = True
                if dirty:
                    await fork.save(someone_typeid)
        except Exception as e:
            logger.warning(
                "[notification_action] fork-task wiring failed (non-fatal): %s", e
            )

    # Register task on hub so the recipient can load it via the hub graph API.
    # Best-effort: a hub failure here shouldn't abort the local share-task flow.
    try:
        await hub_post(BuiltinEntityType.TASK, {
            "id": task.id,
            "title": task_title,
            "task_type": task.task_type,
            "status": task.status,
        })
    except HubError as e:
        logger.warning("[notification_action] hub task register failed (non-fatal): %s", e)

    return spec, task


async def _create_conversation_and_fm(
    *,
    spec: Optional[Spec],
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
    from flow_sdk.app.actions.materialize_flow_message import (
        ensure_conversation_entity,
        materialize_flow_message,
    )
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.fs_store.type_id import TypeId

    task_typeid = TypeId(type=BuiltinEntityType.TASK.value, id=task.id)
    conv_id = Conversation.allocate_id({"context_entities": [str(task_typeid)]})
    conv = await ensure_conversation_entity(
        conv_id, parent_typeid=task_typeid, someone_typeid=someone_typeid
    )
    task.add_context_entity(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))
    task = await task.save(someone_typeid)

    fm_context = [
        task_typeid,
        TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id),
    ]
    fm_id = FlowMessage.allocate_id({"text": message or f"Task shared: {task.title}"})
    attachments: list[Attachment] = []
    if spec:
        attachments.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.SPEC.value, id=spec.id))))
    attachments.extend([
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(task_typeid)),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm_id))),
    ])
    fm = await materialize_flow_message(
        {
            "id": fm_id,
            "text": message or f"Task shared: {task.title}",
            "context_entities": fm_context,
            "attachment": attachments,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "receiver_address": recipient_email,
            "receiver_address_type": "email",
        },
        conversation_id=conv.id,
        someone_typeid=someone_typeid,
    )
    conv = await Conversation.get_one({"id": conv.id})

    return conv, fm


async def _write_task_to_git(
    *,
    project_root: Path,
    spec: Optional[Spec],
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
    """Write spec.md (when present), header.json, conversation.jsonl; create Conversation + FlowMessage.

    Returns (conv, fm, spec_file_path, branch_at_write). `spec_file_path` is
    "" when there is no Spec ("I need help" flow).
    """
    tasks_root = Path(project_root) / "tasks"
    task_dir_name = _unique_dir_name(_meaningful_name(task_title), tasks_root)

    spec_file_path = ""
    spec_dir_name = ""
    if spec:
        spec_root = tasks_root / "spec"
        spec_dir_name = _unique_dir_name(_meaningful_name(spec_title), spec_root)
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
    (task_dir / "header.json").write_text(
        _json.dumps({
            "task_id": task.id,
            "title": task_title,
            "spec_id": spec.id if spec else "",
            "spec_dir": spec_dir_name,
            "shared_by_id": sender_id,
            "sender_name": sender_name,
            "conversation_id": conv.id,
            "created_at": datetime.now(UTC).isoformat(),
            "repo_id": repo_id_val,
            "branch": branch_at_write,
            "project_id": task.project_id or "",
            "project_name": task.project_name or "",
            "spec_type": task.spec_type or "",
        }, indent=2, default=str),
        encoding="utf-8",
    )

    return conv, fm, spec_file_path, branch_at_write


async def _create_local_conversation_and_fm(
    *,
    spec: Optional[Spec],
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
    spec: Optional[Spec],
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
    if not hub_configured:
        return None, None

    # Use the local FlowMessage id as the hub-side id — both sides reference
    # the same key, so a receiver missing this message can call
    # `inbox-open(message_id)` and the hub answers without any hub_id mapping.
    flow_message_id = fm.id if fm else str(uuid.uuid4())
    hub_flow_message_id: Optional[str] = None
    email_error: Optional[str] = None
    try:
        hub_data = await hub_post(BuiltinEntityType.FLOW_MESSAGE, {
            "flow_message_id": flow_message_id,
            "recipient_email": recipient_email,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "task_id": task.id,
            "task_title": task_title,
            "spec_id": spec.id if spec else None,
            "spec_title": spec.title if spec else None,
            "spec_content": (spec.content or None) if spec else None,
            "spec_type": (spec.spec_type if spec else None) or task.spec_type,
            "message": message,
            "project_url": project_url,
            "repo_id": repo_id_val,
            "branch": branch,
            "spec_file_path": spec_file_path,
            "project_id": task.project_id or None,
            "project_name": task.project_name or None,
        }, action="send")
    except HubError as e:
        # Hub returned non-2xx (e.g. 401 unauthorized) or transport error.
        email_error = f"hub call failed ({e.status_code}): {e.reason}" if e.status_code else f"could not reach hub: {e.reason}"
        return None, email_error

    hub_flow_message_id = (hub_data or {}).get("flow_message_id")
    # The hub returns 200 even when the SMTP send itself fails — in that case
    # it sets data.email_error so we can surface the real reason.
    hub_email_error = (hub_data or {}).get("email_error") if hub_data else None
    if hub_email_error:
        email_error = str(hub_email_error)
    elif not hub_flow_message_id:
        email_error = "the notification service did not confirm delivery."

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
        "notification_target": TypeId(type=BuiltinEntityType.TASK.value, id=task.id),
        "notification_subtype": CrudAction.CREATE,
        "recipient_id": resolved_recipient_id,
        "sender_id": sender_id,
        "delivery_method": DeliveryMethod.EMAIL,
        "notification_status": NotificationStatus.SENT if hub_flow_message_id else NotificationStatus.PENDING,
        "message": message,
        "metadata": {
            "project_url": project_url,
            "spec_id": (task.first_context_of_type("spec").id if task.first_context_of_type("spec") else None),
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
    reason: Optional[str],
) -> None:
    """Save a bookmark so the user sees the delivery failure in the activity panel.

    `reason` is the specific failure cause reported by the hub (auth error,
    SMTP rejection, etc.). It is included verbatim so the user can act on it.
    """
    detail = (reason or "").strip() or "no reason reported by the notification service."
    content = (
        f"Task was created but the email to {recipient_email} could not be sent. "
        f"Reason: {detail}"
    )
    failure_bookmark = Bookmark.model_validate({
        "bookmark_type": "notification_failed",
        "title": f"Email not sent: {task_title}",
        "content": content,
        "source": "notification",
        "data": {
            "task_id": task_id,
            "recipient_email": recipient_email,
            "task_title": task_title,
            "notification_id": notification_id,
            "reason": detail,
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
    sender_process_id = (body.get("sender_process_id") or "").strip() or None
    forked_process_id = (body.get("forked_process_id") or "").strip() or None

    if not recipient_id:
        return ApiFailResponse(message="recipient_id is required")
    # No-spec flow ("I need help"): both spec fields blank — require task_title instead.
    if not spec_title and not spec_content and not task_title:
        return ApiFailResponse(message="task_title is required when spec_title and spec_content are blank")
    if spec_title and not task_title:
        task_title = spec_title

    try:
        recipient_email, resolved_recipient_id = await _resolve_recipient(recipient_id)
    except ValueError as e:
        return ApiFailResponse(message=str(e))

    sender_id, sender_name = await User.local_sender_identity(body.get("sender_name"))
    local_user = await User.get_local()
    sender_email: str = (local_user.email or "") if local_user else ""

    project_root = find_project_root(project_path) if project_path else None
    project_url = git_remote_url(project_root) if project_root else ""
    repo_full_name = git_repo_full_name(project_root) if project_root else ""
    repo_id_val = repo_id(repo_full_name) if repo_full_name else ""

    project_id_val, project_name_val = await _resolve_local_project_identity(project_root)

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
        project_id=project_id_val,
        project_name=project_name_val,
        project_root=str(project_root) if project_root else None,
        sender_process_id=sender_process_id,
        forked_process_id=forked_process_id,
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
            reason=email_error,
        )

    base = hub_base_url()
    return ApiSuccessResponse(data={
        "sent": bool(hub_flow_message_id),
        "email_error": email_error,
        "spec_id": spec.id if spec else None,
        "task_id": task.id,
        "conversation_id": conv.id if conv else None,
        "notification_id": notification.id,
        "notify_url": f"{base}/flow_message/{hub_flow_message_id}" if hub_flow_message_id and base else None,
    })


async def _find_task_conversation(task: Task) -> Optional[Conversation]:
    """Look up the Conversation for a task via its context_entities."""
    conv_typeid = task.first_context_of_type(BuiltinEntityType.CONVERSATION.value)
    if conv_typeid:
        conv = await Conversation.get_one({"id": conv_typeid.id})
        if conv:
            return conv
    return None


def _build_reply_flow_message(
    *,
    task_id: Optional[str],
    conv_id: str,
    message: str,
    sender_id: Optional[str],
    sender_name: str,
    is_draft: bool = False,
) -> "FlowMessage":
    """Build (but do not save) the FlowMessage entity for a conversation reply.

    `task_id` is omitted from context/attachments when None — project-scoped
    conversations have no Task. The caller is responsible for attaching any
    uploaded files and then saving.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.fs_store.type_id import TypeId

    context: list = []
    if task_id:
        context.append(TypeId(type=BuiltinEntityType.TASK.value, id=task_id))
    context.append(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv_id))

    reply_fm = FlowMessage.model_validate({
        "text": message,
        "context": context,
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "conversation_id": conv_id,
        "is_draft": is_draft,
    })
    reply_fm.id = FlowMessage.allocate_id(reply_fm.model_dump())
    attachments: list[Attachment] = []
    if task_id:
        attachments.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.TASK.value, id=task_id))))
    attachments.extend([
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv_id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=reply_fm.id))),
    ])
    reply_fm.attachment = attachments
    return reply_fm


async def _attach_prompt(
    reply_fm: "FlowMessage",
    proposer_id: Optional[str],
    prompt_text: str,
    prompt_files: list,
) -> None:
    """Append a PROMPT attachment to the FlowMessage.

    `prompt_text` (if non-empty) is stored inline in `data`. Each file in
    `prompt_files` is written to the entity VFS at `prompt/{filename}` and
    appended as a separate PROMPT attachment whose `data` is that VFS subpath.
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType
    from flow_sdk.storage import get_entity_embedded_storage

    new_atts: list = list(reply_fm.attachment or [])
    if prompt_text:
        new_atts.append(Attachment(
            attachment_type=AttachmentType.PROMPT,
            data=prompt_text,
            proposer_id=proposer_id,
        ))
    if prompt_files:
        storage = get_entity_embedded_storage(reply_fm.typeid)
        for uf in prompt_files:
            if not hasattr(uf, "read"):
                continue
            filename = getattr(uf, "filename", None) or "prompt.txt"
            vfs_subpath = f"prompt/{filename}"
            local_path = Path(storage.get_storage_path(vfs_subpath))
            local_path.parent.mkdir(parents=True, exist_ok=True)
            local_path.write_bytes(await uf.read())
            new_atts.append(Attachment(
                attachment_type=AttachmentType.PROMPT,
                data=vfs_subpath,
                proposer_id=proposer_id,
            ))
    reply_fm.attachment = new_atts


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
    task_id: Optional[str],
    fm_id: str,
    someone_typeid: str,
) -> Conversation:
    """Append a Pointer to conversation.jsonl via the unified write path.

    The FlowMessage row is already saved by the caller (reply send flow); this
    helper only needs to append the pointer + project. We funnel through
    ``materialize_flow_message`` so the WS sequencing (FM CREATE then
    Conversation UPDATE) matches every other producer; the FM upsert is a
    no-op since the row already exists with this id.
    """
    from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message
    from flow_sdk.builtin.flow_message import FlowMessage

    fm = await FlowMessage.get_one({"id": fm_id})
    payload = fm.model_dump() if fm else {"id": fm_id, "text": ""}
    await materialize_flow_message(
        payload,
        conversation_id=conv.id,
        someone_typeid=someone_typeid,
    )
    return await Conversation.get_one({"id": conv.id})


def _resolve_reply_recipient_email(task: Task, local_user_id: str) -> str:
    """Return the email address the reply should be delivered to.

    Direction: if I am the original sender → deliver to recipient; otherwise → deliver to sender.
    """
    if task.shared_by_id and task.shared_by_id == local_user_id:
        return task.recipient_email or ""
    return task.sender_email or ""


async def _read_upload_files(uploads: list) -> dict[str, bytes]:
    """Drain UploadFile objects into an in-memory {filename: bytes} map.

    UploadFile is a single-read stream — we need the bytes twice (once to
    push to the hub, once to land in the local FM's VFS), so read upfront.
    """
    out: dict[str, bytes] = {}
    for uf in uploads or []:
        if not hasattr(uf, "read"):
            continue
        name = getattr(uf, "filename", None) or "file"
        out[name] = await uf.read()
    return out


async def _handle_hub_mirrored_append(
    *,
    conv: Conversation,
    message: str,
    sender_id: Optional[str],
    sender_name: str,
    uploaded_files: list,
    prompt_text: str,
    prompt_files: list,
    someone_typeid: str,
) -> ApiResponse:
    """Hub-mirrored send path: hub allocates the FM id, both sides mirror.

    The local-first append-conversation path doesn't fit hub-mirrored conversations
    because the hub's ``add_message`` action treats a body-supplied ``id`` as a
    reference to an existing entity (and 404s when not found). So we do the
    inverse: push first, materialize locally with the hub-allocated id.
    """
    from flow_sdk.app.actions.flow_message_action import _materialize_remote_flow_message
    from flow_sdk.builtin.flow_message import AttachmentType
    from flow_sdk.storage import get_entity_embedded_storage

    if not hub_base_url():
        return ApiFailResponse(message="Hub not configured")

    file_bytes = await _read_upload_files(uploaded_files)
    prompt_file_bytes = await _read_upload_files(prompt_files)

    attachment: list[dict] = []
    if prompt_text:
        attachment.append({"attachment_type": AttachmentType.PROMPT.value, "data": prompt_text, "proposer_id": sender_id})
    for name in prompt_file_bytes:
        attachment.append({"attachment_type": AttachmentType.PROMPT.value, "data": f"prompt/{name}", "proposer_id": sender_id})
    for name in file_bytes:
        attachment.append({"attachment_type": AttachmentType.FILE.value, "data": f"data/{name}"})

    payload = {
        "text": message,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "attachment": attachment,
    }
    try:
        hub_fm = await hub_post(BuiltinEntityType.CONVERSATION, payload, conv.id, "add_message")
    except HubError as e:
        return ApiFailResponse(message=f"Hub error ({e.status_code}): {e.reason}")
    if not hub_fm or not hub_fm.get("id"):
        return ApiFailResponse(message="Hub returned no flow_message id")
    fm_id = hub_fm["id"]

    # Hub upload path: sub_path is the *destination directory*; the hub's
    # upload action appends the multipart filename. So `upload/data` +
    # filename `foo.png` lands at `data/foo.png` (NOT `data/foo.png/foo.png`).
    logger.warning(
        "[hub_mirrored_append] uploading to hub fm=%s files=%s prompt_files=%s",
        fm_id, list(file_bytes.keys()), list(prompt_file_bytes.keys()),
    )
    for name, data in file_bytes.items():
        try:
            await hub_post(
                BuiltinEntityType.FLOW_MESSAGE, {}, fm_id, "fs", "upload/data",
                files={"uploaded_file": (name, data, "application/octet-stream")},
            )
            logger.warning("[hub_mirrored_append] uploaded data/%s (%d bytes)", name, len(data))
        except HubError as e:
            logger.warning("[hub_mirrored_append] file upload %s failed: %s", name, e)
    for name, data in prompt_file_bytes.items():
        try:
            await hub_post(
                BuiltinEntityType.FLOW_MESSAGE, {}, fm_id, "fs", "upload/prompt",
                files={"uploaded_file": (name, data, "application/octet-stream")},
            )
            logger.warning("[hub_mirrored_append] uploaded prompt/%s (%d bytes)", name, len(data))
        except HubError as e:
            logger.warning("[hub_mirrored_append] prompt file upload %s failed: %s", name, e)

    fm = await _materialize_remote_flow_message(hub_fm, conv.id, someone_typeid)
    if not fm:
        return ApiFailResponse(message="Failed to materialize FlowMessage locally")

    storage = get_entity_embedded_storage(fm.typeid)
    for name, data in file_bytes.items():
        path = Path(storage.get_storage_path(f"data/{name}"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    for name, data in prompt_file_bytes.items():
        path = Path(storage.get_storage_path(f"prompt/{name}"))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    conv = await Conversation.get_one({"id": conv.id})
    return ApiSuccessResponse(data={
        "task_id": "",
        "conversation_id": conv.id,
        "message_count": conv.message_count,
        "flow_message_id": fm.id,
    })


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
        # Use the local reply FM id as the hub-side id so both sides share the
        # same key — receivers missing this reply can fetch it directly via
        # `inbox-open(message_id)` without any side-channel id mapping.
        hub_reply_id = reply_fm.id
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
    """Append a reply to a Conversation.

    Accepts EITHER `task_id` (legacy task-bound path: hub push + git commit) OR
    `conversation_id` (project-scoped conversations: local-only — no hub, no git).
    """
    task_id = (body.get("task_id") or "").strip()
    conversation_id = (body.get("conversation_id") or "").strip()
    message = (body.get("message") or "").strip()
    is_draft = bool(body.get("is_draft"))
    prompt_text_preview = (body.get("prompt_text") or "").strip()
    prompt_files_preview = body.get("prompt_files") or []
    if not isinstance(prompt_files_preview, list):
        prompt_files_preview = [prompt_files_preview]
    uploaded_files_preview = body.get("files") or []
    if not isinstance(uploaded_files_preview, list):
        uploaded_files_preview = [uploaded_files_preview]

    if not task_id and not conversation_id:
        return ApiFailResponse(message="task_id or conversation_id is required")
    if not message and not prompt_text_preview and not prompt_files_preview and not uploaded_files_preview:
        return ApiFailResponse(message="message, prompt, or files required")
    if not message:
        # Synthesize a placeholder so the rest of the pipeline (which assumes a
        # non-empty text body) keeps working for prompt-only / files-only sends.
        # The frontend suppresses the body when it matches this exact constant.
        message = PLACEHOLDER_FOR_EMPTY_MESSAGE_WITH_PROMPT

    task: Optional[Task] = None
    if task_id:
        task = await Task.get_one({"id": task_id})
        if not task:
            return ApiFailResponse(message=f"Task not found: {task_id}")
        conv = await _find_task_conversation(task)
        if not conv:
            return ApiFailResponse(message=f"No conversation found for task {task_id}")
    else:
        conv = await Conversation.get_one({"id": conversation_id})
        if not conv:
            return ApiFailResponse(message=f"Conversation not found: {conversation_id}")

    sender_id, sender_name = await User.local_sender_identity(body.get("sender_name"))

    uploaded_files = body.get("files") or []
    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]
    prompt_text = (body.get("prompt_text") or "").strip()
    prompt_files = body.get("prompt_files") or []
    if not isinstance(prompt_files, list):
        prompt_files = [prompt_files]

    # Hub-mirrored conversations require the hub to allocate the FM id —
    # its add_message action 404s on body-supplied ids — so this path
    # diverges from the local-first sequence.
    if not task and conv.remote and not is_draft:
        return await _handle_hub_mirrored_append(
            conv=conv,
            message=message,
            sender_id=sender_id,
            sender_name=sender_name,
            uploaded_files=uploaded_files,
            prompt_text=prompt_text,
            prompt_files=prompt_files,
            someone_typeid=someone_typeid,
        )

    effective_task_id: Optional[str] = task.id if task else None

    reply_fm = _build_reply_flow_message(
        task_id=effective_task_id,
        conv_id=conv.id,
        message=message,
        sender_id=sender_id,
        sender_name=sender_name,
        is_draft=is_draft,
    )

    if uploaded_files:
        await _attach_uploaded_files(reply_fm, uploaded_files)

    if prompt_text or prompt_files:
        await _attach_prompt(reply_fm, sender_id, prompt_text, prompt_files)

    reply_fm = await reply_fm.save(someone_typeid)

    if is_draft:
        # Local-only draft: skip jsonl append, hub push, and git commit.
        # The UI surfaces the draft via an entity query on (conversation_id, is_draft=true).
        return ApiSuccessResponse(data={
            "task_id": effective_task_id or "",
            "conversation_id": conv.id,
            "message_count": conv.message_count,
            "flow_message_id": reply_fm.id,
            "is_draft": True,
        })

    # Append pointer BEFORE packing the bundle so conversation.jsonl is up-to-date in the zip
    conv = await _append_message_to_conversation(
        conv=conv,
        task_id=effective_task_id,
        fm_id=reply_fm.id,
        someone_typeid=someone_typeid,
    )

    if task:
        local_user = await User.get_local()
        recipient_email = _resolve_reply_recipient_email(task, local_user.id if local_user else "")
        await _send_reply_to_hub(
            reply_fm=reply_fm,
            task=task,
            task_id=task.id,
            message=message,
            sender_id=sender_id,
            sender_name=sender_name,
            recipient_email=recipient_email,
        )

    _notify_ui_conversation_updated(conv.id, effective_task_id or "", reply_fm.id)

    if task:
        project_root_str = task.project_root
        if project_root_str:
            await git_add_commit_push(
                Path(project_root_str),
                ["tasks"],
                f"chore: update conversation for task '{task.title}'",
            )

    return ApiSuccessResponse(data={
        "task_id": effective_task_id or "",
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
    """Update the local user's display name and mark it as manually overridden.

    The override label tells bootstrap not to clobber this name from
    `git config user.name` on future server starts.
    """
    from flow_sdk.server.routes.bootstrap import NAME_OVERRIDE_LABEL

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
    if NAME_OVERRIDE_LABEL not in (local_user.labels or []):
        local_user.add_label(NAME_OVERRIDE_LABEL)
    await local_user.save()
    return ApiSuccessResponse(data={"name": new_name})


# ────────────────────────────────────────────────────────────────────────────
# Project mapping (per-machine: remote_project_id → local_project_id)
# Stored as a JSON file under InstanceSettings.flow_home so the mapping
# survives restarts and is independent of the User entity (which has no
# settings field today).
# ────────────────────────────────────────────────────────────────────────────


def _project_mapping_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().flow_home / "project_mapping.json"


def _load_project_mapping() -> dict:
    p = _project_mapping_path()
    if not p.exists():
        return {}
    try:
        return _json.loads(p.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}


def _save_project_mapping(mapping: dict) -> None:
    p = _project_mapping_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(_json.dumps(mapping, indent=2), encoding="utf-8")


@action.get(action_name="get-project-mapping", types=None)
async def get_project_mapping() -> ApiResponse:
    """Return the per-machine remote→local project mapping dict."""
    return ApiSuccessResponse(data={"mapping": _load_project_mapping()})


@action.post(action_name="set-project-mapping", types=None)
async def set_project_mapping() -> ApiResponse:
    """Set the local project that a remote project_id maps to.

    Body: { remote_project_id: str, local_project_id: str }
    The mapping is keyed by remote_project_id; subsequent messages bound to
    the same remote project route silently to the chosen local project.
    """
    request_info = get_current_request_info()
    if not request_info:
        return ApiFailResponse(message="No request info found")
    body = await request_info.get_post_data() or {}
    remote_id = (body.get("remote_project_id") or "").strip()
    local_id = (body.get("local_project_id") or "").strip()
    if not remote_id or not local_id:
        return ApiFailResponse(message="remote_project_id and local_project_id are required")
    mapping = _load_project_mapping()
    mapping[remote_id] = local_id
    _save_project_mapping(mapping)
    return ApiSuccessResponse(data={"mapping": mapping})


# ────────────────────────────────────────────────────────────────────────────
# PROMPT attachment lifecycle
# ────────────────────────────────────────────────────────────────────────────


@action.post(action_name="approve-prompt", types=["flow_message"])
async def approve_prompt() -> ApiResponse:
    """Mark PROMPT attachments on a FlowMessage as approved by the current user.

    The frontend then runs the prompt in a forked Claude session.
    Body: { attachment_index?: number, approve_all?: bool }
      - With approve_all=True (default for the conversation flow): every PROMPT
        attachment on the message flips to approved in one shot, so the typed
        text and any attached prompt files all execute as a single Claude turn.
      - Without approve_all: only the targeted attachment_index (or the first
        unapproved PROMPT) is approved.
    """
    from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage as FM

    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="No request info found")
    fm_id = str(request_info.target_entity_typeid.id)
    fm = await FM.get_one({"id": fm_id})
    if not fm:
        return ApiFailResponse(message=f"FlowMessage not found: {fm_id}")

    body = await request_info.get_post_data() or {}
    idx = body.get("attachment_index")
    approve_all = bool(body.get("approve_all"))
    local_user = await User.get_one({"uname": "local"})
    approver_id = local_user.id if local_user else None

    new_atts = list(fm.attachment or [])

    if approve_all:
        approved_indices: list[int] = []
        for i, a in enumerate(new_atts):
            if a.attachment_type == AttachmentType.PROMPT and not a.approved_by:
                new_atts[i] = a.model_copy(update={"approved_by": approver_id})
                approved_indices.append(i)
        if not approved_indices:
            return ApiFailResponse(message="No unapproved PROMPT attachment found on this message")
        fm.attachment = new_atts
        await fm.save(request_info.someone_typeid or "")
        return ApiSuccessResponse(data={"attachment_indices": approved_indices, "approved_by": approver_id})

    target_idx: Optional[int] = None
    if isinstance(idx, int) and 0 <= idx < len(new_atts):
        if new_atts[idx].attachment_type == AttachmentType.PROMPT:
            target_idx = idx
    if target_idx is None:
        for i, a in enumerate(new_atts):
            if a.attachment_type == AttachmentType.PROMPT and not a.approved_by:
                target_idx = i
                break
    if target_idx is None:
        return ApiFailResponse(message="No unapproved PROMPT attachment found on this message")

    new_atts[target_idx] = new_atts[target_idx].model_copy(update={"approved_by": approver_id})
    fm.attachment = new_atts
    await fm.save(request_info.someone_typeid or "")
    return ApiSuccessResponse(data={"attachment_index": target_idx, "approved_by": approver_id})


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
