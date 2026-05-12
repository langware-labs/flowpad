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
from typing import Any, Optional

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


def _participant_value(participant: dict | None, key: str) -> str:
    if not isinstance(participant, dict):
        return ""
    value = participant.get(key)
    return value.strip() if isinstance(value, str) else ""


def _participant_from_recipient_id(recipient_id: str) -> dict:
    if not recipient_id:
        return {}
    if "@" in recipient_id:
        return {"email": recipient_id}
    return {"user_id": recipient_id}


def _participants_for_conversation(
    sender_participant: dict,
    raw_participants: list[dict],
    recipient_participant: dict | None,
) -> list[dict]:
    participants = [sender_participant, *list(raw_participants or [])]
    if not raw_participants and recipient_participant:
        participants.append(recipient_participant)
    return participants


async def _learn_address_book_participant(participant: dict | None, fallback_email: str = "") -> None:
    email = _participant_value(participant, "email") or fallback_email
    if not email:
        return
    name = _participant_value(participant, "name") or None
    await User.get_or_create_by_email(email, name=name)


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


async def _resolve_recipient(
    recipient_id: str,
    participant: dict | None = None,
) -> tuple[Optional[str], str, dict]:
    """Return routing info without rewriting the supplied participant."""
    p = participant if isinstance(participant, dict) else _participant_from_recipient_id(recipient_id)
    participant_user_id = _participant_value(p, "user_id")
    participant_email = _participant_value(p, "email")
    recipient_user_id = participant_user_id or (recipient_id if recipient_id and "@" not in recipient_id else "")
    recipient_email = participant_email or (recipient_id if recipient_id and "@" in recipient_id else "")

    recipient_user = await User.get_one({"id": recipient_user_id}) if recipient_user_id else None
    if recipient_user and not recipient_email:
        recipient_email = recipient_user.email or ""

    if recipient_email:
        await _learn_address_book_participant(p, recipient_email)
        return recipient_email, recipient_user_id or recipient_email, p
    if recipient_user:
        return recipient_user.email, recipient_user.id, p or recipient_user.to_participant()
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
                if fork.target_typeid_str != task_vfs:
                    fork.target_typeid_str = task_vfs
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
    task: Optional[Task],
    title: str,
    sender_id: Optional[str],
    sender_name: str,
    sender_email: str,
    recipient_email: Optional[str],
    recipient_participant: Optional[dict],
    participants: Optional[list[dict]],
    message: Optional[str],
    someone_typeid: str,
    project_id: Optional[str] = None,
    project_name: Optional[str] = None,
) -> tuple[Conversation, "FlowMessage"]:
    """Create Conversation + FlowMessage entities.

    Shared by both share_task (with Task) and conversation-start-bundle (no Task).
    When ``task`` is None, ``title`` is used for the FM text fallback and
    project_id/project_name are stamped on the local Conversation directly.
    """
    from flow_sdk.app.actions.materialize_flow_message import (
        ensure_conversation_entity,
        materialize_flow_message,
    )
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.fs_store.type_id import TypeId

    task_typeid: Optional[TypeId] = (
        TypeId(type=BuiltinEntityType.TASK.value, id=task.id) if task else None
    )
    if task_typeid:
        conv_id = Conversation.allocate_id({"context_entities": [str(task_typeid)]})
    else:
        # No-Task share — seed id from sender + title so it's deterministic
        # for retries but not collide-prone with other no-Task shares.
        conv_id = Conversation.allocate_id({
            "title": title,
            "sender_id": sender_id or "",
            "recipient_email": recipient_email or "",
        })
    conv = await ensure_conversation_entity(
        conv_id,
        parent_typeid=task_typeid,
        someone_typeid=someone_typeid,
        project_id=project_id,
        remote_project_id=project_id,
        remote_project_name=project_name,
        title=title,
    )
    if task is not None:
        task.add_context_entity(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))
        task = await task.save(someone_typeid)

    if participants is not None and list(participants) != list(conv.participants or []):
        conv.participants = list(participants)
        conv = await conv.save(someone_typeid)

    fm_context: list = []
    if task_typeid:
        fm_context.append(task_typeid)
    fm_context.append(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))

    fm_text = message or (f"Task shared: {task.title}" if task else f"Conversation: {title}")
    fm_id = FlowMessage.allocate_id({"text": fm_text})
    receiver_user_id = _participant_value(recipient_participant, "user_id")
    receiver_address = receiver_user_id or recipient_email
    receiver_address_type = "id" if receiver_user_id else ("email" if receiver_address else None)
    attachments: list[Attachment] = []
    if spec:
        attachments.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.SPEC.value, id=spec.id))))
    if task_typeid:
        attachments.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(task_typeid)))
    attachments.extend([
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conv.id))),
        Attachment(attachment_type=AttachmentType.TYPE_ID, data=str(TypeId(type=BuiltinEntityType.FLOW_MESSAGE.value, id=fm_id))),
    ])
    fm = await materialize_flow_message(
        {
            "id": fm_id,
            "text": fm_text,
            "context_entities": fm_context,
            "attachment": attachments,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "receiver_address": receiver_address,
            "receiver_address_type": receiver_address_type,
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
    sender_email: str,
    recipient_email: Optional[str],
    recipient_participant: Optional[dict],
    participants: Optional[list[dict]],
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
        title=task_title,
        sender_id=sender_id,
        sender_name=sender_name,
        sender_email=sender_email,
        recipient_email=recipient_email,
        recipient_participant=recipient_participant,
        participants=participants,
        message=message,
        someone_typeid=someone_typeid,
        project_id=task.project_id if task else None,
        project_name=task.project_name if task else None,
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
    task: Optional[Task],
    task_title: str,
    sender_id: Optional[str],
    sender_name: str,
    sender_email: str,
    recipient_email: Optional[str],
    recipient_participant: Optional[dict],
    participants: Optional[list[dict]],
    message: Optional[str],
    someone_typeid: str,
    project_id: Optional[str] = None,
    project_name: Optional[str] = None,
) -> tuple[Conversation, "FlowMessage"]:
    """Create Conversation + FlowMessage locally without git.

    Used when there is no project_root — ensures a .flowmsg bundle can still
    be packed and uploaded to the hub so the recipient can materialise the task
    (or, for no-Task shares, the conversation).
    """
    return await _create_conversation_and_fm(
        spec=spec,
        task=task,
        title=task_title,
        sender_id=sender_id,
        sender_name=sender_name,
        sender_email=sender_email,
        recipient_email=recipient_email,
        recipient_participant=recipient_participant,
        participants=participants,
        message=message,
        someone_typeid=someone_typeid,
        project_id=project_id or (task.project_id if task else None),
        project_name=project_name or (task.project_name if task else None),
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
    participants: Optional[list[dict]],
    task_id: Optional[str],
    task_project_id: Optional[str],
    task_project_name: Optional[str],
    task_spec_type: Optional[str],
    spec: Optional[Spec],
    message: Optional[str],
    project_url: str,
    repo_id_val: str,
    branch: str,
    spec_file_path: str,
    fm: Optional["FlowMessage"],
    task_title: str,
    is_initial_share: bool = True,
) -> tuple[Optional[str], Optional[str]]:
    """POST notification to hub and upload the .flowmsg bundle.

    Returns (hub_flow_message_id, email_error). ``task_id`` is None for no-Task
    shares (Scenario B) — the hub accepts an empty/missing task_id.
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
            "participants": list(participants or []),
            "task_id": task_id or "",
            "task_title": task_title,
            "spec_id": spec.id if spec else None,
            "spec_title": spec.title if spec else None,
            "spec_content": (spec.content or None) if spec else None,
            "spec_type": (spec.spec_type if spec else None) or task_spec_type,
            "message": message,
            "project_url": project_url,
            "repo_id": repo_id_val,
            "branch": branch,
            "spec_file_path": spec_file_path,
            "project_id": task_project_id or None,
            "project_name": task_project_name or None,
            "is_initial_share": is_initial_share,
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


def _bundle_filename_for(task_title: str) -> str:
    """Deterministic .flowmsg filename for a given title — callable before the
    FM exists so callers can pre-stamp ``attachment_filename`` on the hub FM at
    creation time (avoids a follow-up PUT, which 'member'-role senders can't make).
    """
    return f"{_meaningful_name(task_title)}.flowmsg"


async def _pack_and_upload_bundle(
    hub_flow_message_id: str, fm: "FlowMessage", bundle_filename: str,
) -> bool:
    """Pack the FM into a .flowmsg zip and POST it to the hub's fs/upload action.

    Best-effort: returns True on success, False (with a warning) on any failure.
    Caller is responsible for ensuring ``attachment_filename`` lands on the hub
    FM record — either via this function's companion ``_upload_bundle_to_hub``
    (PUT-based) or by including the field in the FM's create-time payload.
    """
    try:
        zip_path = await fm.to_file()
        content = zip_path.read_bytes()
        await hub_post(
            BuiltinEntityType.FLOW_MESSAGE, {}, hub_flow_message_id, "fs", "upload",
            files={"uploaded_file": (bundle_filename, content, "application/zip")},
        )
        zip_path.unlink(missing_ok=True)
        return True
    except Exception as _upload_err:
        logger.warning("[notification_action] bundle upload to hub failed (non-fatal): %s", _upload_err)
        return False


async def _upload_bundle_to_hub(hub_flow_message_id: str, fm: "FlowMessage", task_title: str) -> None:
    """Pack, upload, and stamp ``attachment_filename`` on the hub FM via PUT.

    Used by the task-bound reply path where the sender owns the FM and the
    follow-up PUT is permitted. The plain-conversation path can't use this
    (members lack PUT access on flow_message); it pre-stamps
    ``attachment_filename`` via the ``add_message`` body and calls
    ``_pack_and_upload_bundle`` directly.
    """
    bundle_filename = _bundle_filename_for(task_title)
    if not await _pack_and_upload_bundle(hub_flow_message_id, fm, bundle_filename):
        return
    try:
        await hub_put(
            BuiltinEntityType.FLOW_MESSAGE,
            hub_flow_message_id,
            {"attachment_filename": bundle_filename},
        )
    except Exception as _put_err:
        logger.warning(
            "[notification_action] bundle attachment_filename PUT failed (non-fatal): %s",
            _put_err,
        )


async def _save_failure_notification(
    *,
    task_id: Optional[str],
    conversation_id: Optional[str],
    spec_id: Optional[str],
    resolved_recipient_id: str,
    sender_id: Optional[str],
    sender_name: str,
    project_url: str,
    message: Optional[str],
    email_error: str,
    someone_typeid: str,
) -> Notification:
    """Create and save a local Notification only for delivery failures.

    For Task-bound shares (A/C), notification_target is the Task. For
    Task-less shares (B), it falls back to the Conversation.
    """
    if task_id:
        target = TypeId(type=BuiltinEntityType.TASK.value, id=task_id)
    elif conversation_id:
        target = TypeId(type=BuiltinEntityType.CONVERSATION.value, id=conversation_id)
    else:
        raise ValueError("_save_failure_notification requires task_id or conversation_id")

    notification = Notification.model_validate({
        "notification_type": NotificationType.ALERT,
        "notification_target": target,
        "notification_subtype": CrudAction.CREATE,
        "recipient_id": resolved_recipient_id,
        "sender_id": sender_id,
        "delivery_method": DeliveryMethod.EMAIL,
        "notification_status": NotificationStatus.PENDING,
        "message": message,
        "metadata": {
            "project_url": project_url,
            "spec_id": spec_id,
            "sender_name": sender_name,
            "email_error": email_error,
        },
    })
    notification.id = Notification.allocate_id(notification.model_dump())
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


async def _share_via_bundle(
    *,
    spec: Optional[Spec],
    task: Optional[Task],
    task_title: str,
    sender_id: Optional[str],
    sender_name: str,
    sender_email: str,
    recipient_email: Optional[str],
    recipient_participant: Optional[dict],
    participants: Optional[list[dict]],
    resolved_recipient_id: str,
    project_id: Optional[str],
    project_name: Optional[str],
    project_root: Optional[Path],
    project_url: str,
    repo_id_val: str,
    message: Optional[str],
    files: list,
    someone_typeid: str,
    spec_title: str = "",
    spec_type: str = "plan",
    plan_id: Optional[str] = None,
    is_initial_share: bool = True,
) -> ApiResponse:
    """Shared sender-side delivery: Conversation+FM → bundle pack → hub upload.

    Both ``share_task`` (with Spec+Task) and ``conversation-start-bundle`` (no Task)
    converge here so there is exactly one delivery codepath.

    ``is_initial_share`` is forwarded to the hub; when False, the hub skips the
    Invitation row so the recipient sees no Accept button (Scenario C).
    """
    conv: Optional[Conversation] = None
    fm = None
    spec_file_path = ""
    branch = ""
    if project_root and task is not None:
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
            sender_email=sender_email,
            recipient_email=recipient_email,
            recipient_participant=recipient_participant,
            participants=participants,
            message=message,
            repo_id_val=repo_id_val,
            someone_typeid=someone_typeid,
        )
        git_error = await _push_task_changes(project_root, task_title)
        if git_error:
            return ApiSuccessResponse(data={"sent": False, "git_error": git_error})
        branch = git_current_branch(project_root)
    else:
        # No git project (or no Task) — create Conversation + FlowMessage locally
        # so the .flowmsg bundle can be packed and uploaded to the hub.
        conv, fm = await _create_local_conversation_and_fm(
            spec=spec,
            task=task,
            task_title=task_title,
            sender_id=sender_id,
            sender_name=sender_name,
            sender_email=sender_email,
            recipient_email=recipient_email,
            recipient_participant=recipient_participant,
            participants=participants,
            message=message,
            someone_typeid=someone_typeid,
            project_id=project_id,
            project_name=project_name,
        )

    # Attach uploaded files to the FlowMessage (stored in entity VFS, included in bundle)
    if files and fm:
        await _attach_uploaded_files(fm, files)
        fm = await fm.save(someone_typeid)

    hub_flow_message_id, email_error = await _send_hub_notification(
        recipient_email=recipient_email,
        sender_id=sender_id,
        sender_name=sender_name,
        participants=participants,
        task_id=(task.id if task else None),
        task_project_id=(task.project_id if task else project_id),
        task_project_name=(task.project_name if task else project_name),
        task_spec_type=(task.spec_type if task else None),
        spec=spec,
        message=message,
        project_url=project_url,
        repo_id_val=repo_id_val,
        branch=branch,
        spec_file_path=spec_file_path,
        fm=fm,
        task_title=task_title,
        is_initial_share=is_initial_share,
    )

    notification: Optional[Notification] = None

    if email_error:
        notification = await _save_failure_notification(
            task_id=(task.id if task else None),
            conversation_id=(conv.id if conv else None),
            spec_id=(spec.id if spec else None),
            resolved_recipient_id=resolved_recipient_id,
            sender_id=sender_id,
            sender_name=sender_name,
            project_url=project_url,
            message=message,
            email_error=email_error,
            someone_typeid=someone_typeid,
        )
        await _save_failure_bookmark(
            task_id=(task.id if task else ""),
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
        "task_id": task.id if task else None,
        "conversation_id": conv.id if conv else None,
        "notification_id": notification.id if notification else None,
        "notify_url": f"{base}/flow_message/{hub_flow_message_id}" if hub_flow_message_id and base else None,
    })


async def handle_send_notification(body: dict, someone_typeid: str) -> ApiResponse:
    """Create Spec + Task + Conversation, write to git repo, push, post to hub."""
    recipient_id = (body.get("recipient_id") or "").strip()
    raw_participants = body.get("participants") or []
    if not isinstance(raw_participants, list):
        raw_participants = []
    recipient_participant = raw_participants[0] if raw_participants and isinstance(raw_participants[0], dict) else {}
    if not recipient_id:
        recipient_id = _participant_value(recipient_participant, "user_id") or _participant_value(recipient_participant, "email")
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
    # Default True for back-compat (Scenarios A/B). Scenario C passes False so
    # the hub skips Invitation creation — recipient already has access via the
    # FlowMessage `grant_role`, and the "Accept" button on the strip would be
    # spurious for an existing-collaborator share.
    is_initial_share_raw = body.get("is_initial_share")
    if isinstance(is_initial_share_raw, str):
        is_initial_share = is_initial_share_raw.strip().lower() not in ("false", "0", "")
    else:
        is_initial_share = bool(is_initial_share_raw) if is_initial_share_raw is not None else True

    if not recipient_id:
        return ApiFailResponse(message="recipient_id is required")
    # No-spec flow ("I need help"): both spec fields blank — require task_title instead.
    if not spec_title and not spec_content and not task_title:
        return ApiFailResponse(message="task_title is required when spec_title and spec_content are blank")
    if spec_title and not task_title:
        task_title = spec_title

    sender_participant = await User.current_sender_participant(body.get("sender_name"))
    sender_id = sender_participant.get("user_id") or None
    sender_name = sender_participant.get("name") or ""
    sender_email = sender_participant.get("email") or ""

    try:
        recipient_email, resolved_recipient_id, recipient_participant = await _resolve_recipient(
            recipient_id,
            recipient_participant,
        )
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    participants = _participants_for_conversation(sender_participant, raw_participants, recipient_participant)

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

    return await _share_via_bundle(
        spec=spec,
        task=task,
        task_title=task_title,
        sender_id=sender_id,
        sender_name=sender_name,
        sender_email=sender_email,
        recipient_email=recipient_email,
        recipient_participant=recipient_participant,
        participants=participants,
        resolved_recipient_id=resolved_recipient_id,
        project_id=project_id_val,
        project_name=project_name_val,
        project_root=project_root,
        project_url=project_url,
        repo_id_val=repo_id_val,
        message=message,
        files=uploaded_files,
        someone_typeid=someone_typeid,
        spec_title=spec_title,
        spec_type=spec_type,
        plan_id=plan_id,
        is_initial_share=is_initial_share,
    )


async def handle_start_conversation_bundle(body: dict, someone_typeid: str) -> ApiResponse:
    """Start a cross-user conversation from homelanding (no underlying Task).

    Uses the same .flowmsg bundle delivery as ``share_task`` — exactly one
    delivery codepath. Recipient receives a pending invitation linked to the
    initial FlowMessage; on accept, the bundle is downloaded and the
    Conversation materializes locally.
    """
    recipient_id = (body.get("recipient_id") or "").strip()
    raw_participants = body.get("participants") or []
    if not isinstance(raw_participants, list):
        raw_participants = []
    recipient_participant = raw_participants[0] if raw_participants and isinstance(raw_participants[0], dict) else {}
    if not recipient_id:
        recipient_id = _participant_value(recipient_participant, "user_id") or _participant_value(recipient_participant, "email")
    title = (body.get("title") or "").strip()
    message = (body.get("message") or body.get("initial_text") or "").strip() or None
    project_id_val = (body.get("project_id") or "").strip() or None
    project_name_val = (body.get("project_name") or "").strip() or None
    files = body.get("files") or []
    if not isinstance(files, list):
        files = [files]

    if not recipient_id:
        return ApiFailResponse(message="recipient_id is required", status_code=400)
    if not title and not message and not files:
        return ApiFailResponse(message="At least one of title, message, or files is required", status_code=400)

    sender_participant = await User.current_sender_participant(body.get("sender_name"))
    sender_id = sender_participant.get("user_id") or None
    sender_name = sender_participant.get("name") or ""
    sender_email = sender_participant.get("email") or ""

    try:
        recipient_email, resolved_recipient_id, recipient_participant = await _resolve_recipient(
            recipient_id,
            recipient_participant,
        )
    except ValueError as e:
        return ApiFailResponse(message=str(e), status_code=400)
    participants = _participants_for_conversation(sender_participant, raw_participants, recipient_participant)

    # Title used for bundle filename + shown to recipient. Fall back to a
    # truncated message preview when title is blank.
    conv_title = title or (message[:60] if message else "Conversation")

    # Resolve sender's local Project name when the caller passed a project_id
    # but not a name — the bundle stamps it as remote_project_name on the
    # receiver side for display in the project-mapping prompt.
    if project_id_val and not project_name_val:
        try:
            from flow_sdk.builtin.project import Project
            proj = await Project.get_one({"id": project_id_val})
            if proj:
                project_name_val = proj.name
        except Exception as e:
            logger.warning("[notification_action] project name lookup failed: %s", e)

    return await _share_via_bundle(
        spec=None,
        task=None,
        task_title=conv_title,
        sender_id=sender_id,
        sender_name=sender_name,
        sender_email=sender_email,
        recipient_email=recipient_email,
        recipient_participant=recipient_participant,
        participants=participants,
        resolved_recipient_id=resolved_recipient_id,
        project_id=project_id_val,
        project_name=project_name_val,
        project_root=None,
        project_url="",
        repo_id_val="",
        message=message,
        files=files,
        someone_typeid=someone_typeid,
    )


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
    recipient_participant: Optional[dict] = None,
    is_draft: bool = False,
    context_entities: Optional[list[str]] = None,
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
    if context_entities:
        seen = {str(ce) for ce in context}
        for raw in context_entities:
            s = (raw or "").strip()
            if not s or s in seen:
                continue
            try:
                context.append(TypeId(s))
                seen.add(s)
            except ValueError:
                continue

    receiver_user_id = _participant_value(recipient_participant, "user_id")
    receiver_email = _participant_value(recipient_participant, "email")
    receiver_address = receiver_user_id or receiver_email or None
    receiver_address_type = "id" if receiver_user_id else ("email" if receiver_address else None)

    reply_fm = FlowMessage.model_validate({
        "text": message,
        "context_entities": context,
        "attachment": [],
        "sender_id": sender_id,
        "sender_name": sender_name,
        "receiver_address": receiver_address,
        "receiver_address_type": receiver_address_type,
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
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, PROMPT_FILE_VFS_PREFIX
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
            vfs_subpath = f"{PROMPT_FILE_VFS_PREFIX}{filename}"
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
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FILE_VFS_PREFIX
    from flow_sdk.storage import get_entity_embedded_storage

    fm_typeid = reply_fm.typeid
    storage = get_entity_embedded_storage(fm_typeid)
    new_attachments: list = list(reply_fm.attachment or [])
    added_any = False
    for uf in uploaded_files:
        if not hasattr(uf, "read"):
            continue
        filename = getattr(uf, "filename", None) or "file"
        vfs_subpath = f"{FILE_VFS_PREFIX}{filename}"
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


def _parse_asset_references(raw: Any) -> list:
    """Normalize ``asset_references`` body field into a list of typeid strings.

    Multipart bodies arrive as a JSON-encoded string (``sendReply`` does
    ``form.append('asset_references', JSON.stringify([...]))``); JSON bodies
    arrive as an already-decoded list. A scalar string is wrapped in a list.
    """
    import json

    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x) for x in raw if isinstance(x, (str, bytes))]
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", errors="replace")
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            parsed = json.loads(s)
        except json.JSONDecodeError:
            return [s]
        if isinstance(parsed, list):
            return [str(x) for x in parsed if isinstance(x, (str, bytes))]
        if isinstance(parsed, str):
            return [parsed]
        return []
    return []


async def _attach_asset_references(reply_fm: "FlowMessage", asset_typeids: list) -> None:
    """Append TYPE_ID attachments for each asset typeid string on the FlowMessage.

    Mirrors ``_attach_uploaded_files`` for assets — the typeid is stored verbatim
    in ``Attachment.data`` so downstream readers can resolve it via TypeId(...).
    """
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType

    new_attachments: list = list(reply_fm.attachment or [])
    added_any = False
    for tid in asset_typeids:
        if not isinstance(tid, str) or not tid.strip():
            continue
        new_attachments.append(Attachment(attachment_type=AttachmentType.TYPE_ID, data=tid.strip()))
        added_any = True
    if added_any:
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


def _resolve_reply_recipient_email(
    task: Optional[Task], conv: Optional[Conversation], local_user_email: str, local_user_id: str
) -> str:
    """Return the email address the reply should be delivered to.

    For Task-bound conversations: if I'm the original sender → deliver to
    recipient; otherwise → deliver to sender.

    For no-Task conversations (Scenario B): pick the participant whose email
    differs from mine. Conversation.participants is stamped at create time
    with both parties' emails.
    """
    if task is not None:
        if task.shared_by_id and task.shared_by_id == local_user_id:
            return task.recipient_email or ""
        return task.sender_email or ""

    if conv is None:
        return ""
    me = (local_user_email or "").lower()
    for p in conv.participants or []:
        if not isinstance(p, dict):
            continue
        email = (p.get("email") or "").strip()
        if email and email.lower() != me:
            return email
    return ""


def _resolve_reply_recipient_participant(
    task: Optional[Task], conv: Optional[Conversation], local_user_email: str, local_user_id: str
) -> dict:
    """Return the other conversation participant, falling back to task emails."""
    me_email = (local_user_email or "").lower()
    me_id = local_user_id or ""
    if conv is not None:
        for raw in conv.participants or []:
            if not isinstance(raw, dict):
                continue
            participant_user_id = _participant_value(raw, "user_id")
            participant_email = _participant_value(raw, "email")
            if participant_user_id and me_id and participant_user_id == me_id:
                continue
            if participant_email and me_email and participant_email.lower() == me_email:
                continue
            if participant_user_id or participant_email:
                return raw
    email = _resolve_reply_recipient_email(task, conv, local_user_email, local_user_id)
    return {"email": email} if email else {}


async def _send_reply_to_hub(
    *,
    reply_fm: "FlowMessage",
    task: Optional[Task],
    conv_title: str,
    message: str,
    sender_id: Optional[str],
    sender_name: str,
    recipient_email: str,
    participants: Optional[list[dict]],
) -> None:
    """POST the reply notification to hub and upload the .flowmsg bundle (best-effort).

    ``task`` is None for replies on no-Task conversations (Scenario B);
    ``conv_title`` is then used as the bundle filename.
    """
    if not recipient_email or not hub_base_url():
        return
    try:
        # Use the local reply FM id as the hub-side id so both sides share the
        # same key — receivers missing this reply can fetch it directly via
        # `inbox-open(message_id)` without any side-channel id mapping.
        hub_reply_id = reply_fm.id
        title = (task.title if task else conv_title) or "reply"
        hub_data = await hub_post(BuiltinEntityType.FLOW_MESSAGE, {
            "flow_message_id": hub_reply_id,
            "recipient_email": recipient_email,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "participants": list(participants or []),
            "task_id": (task.id if task else ""),
            "task_title": title,
            "message": message,
        }, action="send")
        hub_reply_fm_id = (hub_data or {}).get("flow_message_id")
        if hub_reply_fm_id:
            await _upload_bundle_to_hub(hub_reply_fm_id, reply_fm, f"reply-{title}")
        else:
            logger.warning("[append_conversation] hub_post(send) returned no flow_message_id")
    except Exception as _hub_err:
        logger.warning("[append_conversation] hub reply upload failed (non-fatal): %s", _hub_err, exc_info=True)


async def _hub_knows_conversation(conv_id: str) -> bool:
    """Quick HTTP probe to decide whether the hub knows this conversation."""
    try:
        import httpx
        from flow_sdk.cli.auth.credentials import load_credentials
        from flow_sdk.cloud_client.client import ApiConfig

        creds = load_credentials()
        if not creds or not creds.api_key:
            return False
        api = ApiConfig.from_env()
        url = api._get_full_url(f"/graph/conversation/{conv_id}")
        headers = {"Authorization": f"Bearer {creds.api_key}", "Accept": "application/json"}
        async with httpx.AsyncClient(timeout=3.0) as h:
            r = await h.get(url, headers=headers)
            if r.status_code != 200:
                return False
            body = r.json()
            return (body or {}).get("status") == "SUCCESS" and bool((body or {}).get("data"))
    except Exception:
        return False


async def _try_send_reply_via_hub(
    *,
    conv_id: str,
    text: str,
    sender_name: str,
    sender_id: Optional[str],
    someone_typeid: str,
) -> Optional[ApiResponse]:
    """If ``conv_id`` is a hub-mirrored conversation, push the reply through
    the hub bridge so the other party gets it via their own bridge. Returns
    the API response on success, ``None`` to fall through to local-only.
    """
    try:
        from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge
        from flow_sdk.cloud_client.ws_client import hub_ws_manager
    except Exception:
        return None

    if not hub_ws_manager.is_connected:
        return None

    if not hub_ws_bridge.is_hub_conversation(conv_id):
        # Bridge hasn't seen an inbound event for this conv this session
        # (e.g., it landed on a previous run and the in-memory set didn't
        # survive restart). Probe the hub directly — if the hub knows the
        # conv, treat it as hub-mirrored and remember for the rest of this
        # session.
        if not await _hub_knows_conversation(conv_id):
            return None
        hub_ws_bridge.remember_hub_conversation(conv_id)

    try:
        resp = await hub_ws_bridge.add_message(
            conversation_id=conv_id,
            text=text,
            sender_name=sender_name or None,
        )
    except Exception as e:
        logger.warning("[append_conversation] hub add_message failed: %s", e, exc_info=True)
        return None

    fm_payload = (resp or {}).get("data") or {}
    hub_fm_id = fm_payload.get("id")
    if not hub_fm_id:
        logger.warning("[append_conversation] hub add_message returned no id; falling through")
        return None

    # Materialize the hub-confirmed message into the local store. Sender side
    # only — hub fanout skips the sender, so this is the local UI's source of
    # truth for this row.
    try:
        from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

        payload = dict(fm_payload)
        payload["id"] = hub_fm_id
        payload["text"] = text
        if sender_id and not payload.get("sender_id"):
            payload["sender_id"] = sender_id
        if sender_name and not payload.get("sender_name"):
            payload["sender_name"] = sender_name
        await materialize_flow_message(
            payload,
            conversation_id=conv_id,
            someone_typeid=someone_typeid,
            notify=True,
        )
    except Exception as e:
        logger.warning("[append_conversation] hub-side reply materialize failed: %s", e, exc_info=True)
        # Hub got the message; local UI will pick it up on the next refetch.

    conv_after = await Conversation.get_one({"id": conv_id})
    message_count = conv_after.message_count if conv_after else 0
    _notify_ui_conversation_updated(conv_id, "", hub_fm_id)
    return ApiSuccessResponse(data={
        "task_id": "",
        "conversation_id": conv_id,
        "message_count": message_count,
        "flow_message_id": hub_fm_id,
    })


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
    asset_references = _parse_asset_references(body.get("asset_references"))
    context_entities = body.get("context_entities") or []
    if isinstance(context_entities, str):
        context_entities = [context_entities]
    elif not isinstance(context_entities, list):
        context_entities = []

    if not task_id and not conversation_id:
        return ApiFailResponse(message="task_id or conversation_id is required")
    if (
        not message
        and not prompt_text_preview
        and not prompt_files_preview
        and not uploaded_files_preview
        and not asset_references
    ):
        return ApiFailResponse(message="message, prompt, files, or asset_references required")
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

    sender_participant = await User.current_sender_participant(body.get("sender_name"))
    sender_id = sender_participant.get("user_id") or None
    sender_name = sender_participant.get("name") or ""
    sender_email = sender_participant.get("email") or ""
    recipient_participant = _resolve_reply_recipient_participant(
        task,
        conv,
        sender_email,
        sender_id or "",
    )

    uploaded_files = body.get("files") or []
    if not isinstance(uploaded_files, list):
        uploaded_files = [uploaded_files]
    prompt_text = (body.get("prompt_text") or "").strip()
    prompt_files = body.get("prompt_files") or []
    if not isinstance(prompt_files, list):
        prompt_files = [prompt_files]

    # Hub-mirrored conversation: round-trip the reply through the hub so the
    # other party receives it via their own bridge. Only when this is a plain
    # text reply (no attachments / prompts / draft) — the hub action shape
    # doesn't currently carry those, and the local-only path handles them.
    if (
        not task_id
        and not is_draft
        and not uploaded_files
        and not prompt_text
        and not prompt_files
        and not asset_references
    ):
        hub_response = await _try_send_reply_via_hub(
            conv_id=conv.id,
            text=message,
            sender_name=sender_name,
            sender_id=sender_id,
            someone_typeid=someone_typeid,
        )
        if hub_response is not None:
            return hub_response

    effective_task_id: Optional[str] = task.id if task else None

    reply_fm = _build_reply_flow_message(
        task_id=effective_task_id,
        conv_id=conv.id,
        message=message,
        sender_id=sender_id,
        sender_name=sender_name,
        recipient_participant=recipient_participant,
        is_draft=is_draft,
        context_entities=context_entities,
    )

    if uploaded_files:
        await _attach_uploaded_files(reply_fm, uploaded_files)

    if asset_references:
        await _attach_asset_references(reply_fm, asset_references)

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

    recipient_email = recipient_participant.get("email") or _resolve_reply_recipient_email(
        task,
        conv,
        sender_email,
        sender_id or "",
    )
    if recipient_email:
        await _send_reply_to_hub(
            reply_fm=reply_fm,
            task=task,
            conv_title=(conv.name or "") if conv else "",
            message=message,
            sender_id=sender_id,
            sender_name=sender_name,
            recipient_email=recipient_email,
            participants=list(conv.participants or []),
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


@action.post(action_name="conversation-start-bundle", types=None)
async def conversation_start_bundle() -> ApiResponse:
    """Start a Task-less conversation via the bundle delivery path.

    Same delivery mechanism as ``share_task``; the only difference is no
    Task/Spec entities are created. Recipient gets a pending invitation
    linked to the initial FlowMessage and the bundle on accept.
    """
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request info found")
        if not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")
        body = await request_info.get_post_data() or {}
        return await handle_start_conversation_bundle(body, request_info.someone_typeid)
    except Exception as e:
        logger.error(f"[notification_action] conversation-start-bundle error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to start conversation: {str(e)}")


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
    # Notification.id is the same as the hub FlowMessage id (set in
    # _save_local_notification), so we use notification_id as fm_id.
    return await handle_notification_deep_link(
        fm_id=notification_id,
        task_id=(meta.get("task_id") or (data or {}).get("task_id") or "").strip(),
        project_url=(meta.get("project_url") or (data or {}).get("project_url") or "").strip(),
        branch=(meta.get("branch") or (data or {}).get("branch") or "").strip(),
        repo_id=(meta.get("repo_id") or (data or {}).get("repo_id") or "").strip(),
        sender_name=(meta.get("sender_name") or (data or {}).get("sender_name") or "").strip(),
        title=(meta.get("task_title") or (data or {}).get("task_title") or "").strip(),
    )
