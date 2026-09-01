"""Scanner for incoming cross-user notifications.

On the RECIPIENT side: walks known Claude project roots looking for
tasks/*/header.json files that were committed by the sender. If the
header identifies this user as the recipient (via sender + notification
data), creates the Task, Spec, and Conversation entities in the local DB.

Called on: server startup, after git_pull, on-demand via API.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from flow_sdk import service_log
from flow_sdk.builtin.bookmark import Bookmark, BookmarkStatus, BookmarkType
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.fs_store import SyncOperation
from flow_sdk.fs_store.indexer.functions._claude_projects import iter_claude_project_paths

logger = logging.getLogger(__name__)


async def scan_incoming_notifications(local_user_id: str) -> list[str]:
    """Scan all known project roots for incoming task manifests.

    Looks for tasks/*/manifest.json files placed by the sender after a git push.
    Returns list of task IDs processed.
    """
    processed_ids: list[str] = []

    for project_root in iter_claude_project_paths():
        tasks_dir = project_root / "tasks"
        if not tasks_dir.is_dir():
            continue

        for task_dir in sorted(tasks_dir.iterdir()):
            if not task_dir.is_dir() or task_dir.name == "spec":
                continue
            manifest_file = task_dir / "header.json"
            if not manifest_file.exists():
                continue
            try:
                await _process_manifest(manifest_file, task_dir, project_root, local_user_id, processed_ids)
            except Exception as e:
                service_log.error(f"notification_scanner: error processing {manifest_file}: {e}")

    return processed_ids


async def scan_task_in_repo(local_user_id: str, repo_path: str, task_id: str) -> bool:
    """Find and process the manifest for a specific task_id in a repo.

    Task directories are named after the task title (not the task ID), so we
    scan all task dirs and match by the task_id field inside the manifest.
    Used after pull/clone to ensure the task entity exists before the UI navigates to it.

    Returns True if the task was processed.
    """
    from pathlib import Path as _Path
    tasks_dir = _Path(repo_path) / "tasks"
    if not tasks_dir.is_dir():
        logger.warning(f"notification_scanner: scan_task_in_repo: no tasks dir at {repo_path}")
        return False

    processed_ids: list[str] = []
    for task_dir in sorted(tasks_dir.iterdir()):
        if not task_dir.is_dir() or task_dir.name == "spec":
            continue
        manifest_file = task_dir / "header.json"
        if not manifest_file.exists():
            continue
        try:
            data = json.loads(manifest_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if data.get("task_id") != task_id:
            continue
        try:
            await _process_manifest(manifest_file, task_dir, _Path(repo_path), local_user_id, processed_ids)
        except Exception as e:
            logger.warning(f"notification_scanner: scan_task_in_repo error processing {manifest_file}: {e}")
            return False
        return True  # found and processed (or already existed)

    logger.warning(f"notification_scanner: scan_task_in_repo: no manifest found for task_id={task_id} in {repo_path}")
    return False


async def _process_manifest(
    manifest_file: Path,
    task_dir: Path,
    project_root: Path,
    local_user_id: str,
    processed_ids: list[str],
) -> None:
    """Process a single tasks/*/manifest.json file."""
    data = json.loads(manifest_file.read_text(encoding="utf-8"))

    task_id = data.get("task_id")
    if not task_id:
        return

    # If already imported, sync the conversation.jsonl → Conversation entity if it changed
    existing_task = await Task.get_one({"id": task_id})
    if existing_task is not None:
        await _sync_conversation(existing_task, task_dir)
        return

    sender_id = data.get("shared_by_id") or data.get("sender_id")
    sender_name = data.get("sender_name") or "Someone"
    spec_id = data.get("spec_id")
    spec_dir_name = data.get("spec_dir")
    task_title = data.get("title") or "Shared task"
    conversation_id = data.get("conversation_id")
    manifest_branch = data.get("branch") or ""
    remote_project_id = data.get("project_id") or ""
    remote_project_name = data.get("project_name") or ""
    spec_type_meta = data.get("spec_type") or ""

    # Don't import tasks that were created by the local user (sender)
    if sender_id == local_user_id:
        return

    local_user = await User.get_one({"uname": "local"})
    owner_typeid = local_user.typeid if local_user else None

    # --- Create Spec entity from disk (non-fatal) ---
    if spec_id and spec_dir_name:
        spec_file = project_root / "tasks" / "spec" / spec_dir_name / "spec.md"
        if spec_file.exists():
            try:
                await _create_spec_from_file(spec_file, spec_id, owner_typeid)
            except Exception as spec_err:
                logger.warning(f"notification_scanner: spec creation failed (non-fatal), task will still be imported: {spec_err}")

    # --- Resolve GitOrigin from git remote ---
    from flow_sdk.fs_store.origin.git_origin import GitOrigin
    from flow_sdk.utils.git import git_remote_url
    clone_url = git_remote_url(str(project_root))
    git_origin = GitOrigin.from_url(clone_url, branch=manifest_branch, rel_path=".") if clone_url else None

    # Conversation.project_id (the *local* mapped project) is intentionally
    # left null on receive — the picker stamps it when the user maps. The
    # *remote* provenance (sender's project_id / name) is stamped here so the
    # mapping gate can route subsequent messages without re-prompting.
    conv = await _create_conversation_from_disk(
        task_dir=task_dir,
        task_id=task_id,
        conversation_id=conversation_id,
        owner_typeid=owner_typeid,
        project_id=None,
        remote_project_id=remote_project_id,
        remote_project_name=remote_project_name,
    )

    # --- Create Task entity ---
    task = Task.model_validate({
        "id": task_id,
        "title": task_title,
        "spec_id": spec_id,
        "shared_by_id": sender_id,
        "conversation_id": conv.id if conv else None,
        "project_root": str(project_root),
        "git_origin": git_origin.model_dump(mode="json") if git_origin else None,
        "sender_name": sender_name,
        "sender_email": data.get("sender_email") or "",
        "spec_type": spec_type_meta,
    })
    task = await task.save(owner_typeid)

    # DB-level parent-child composition: task → conversation
    if conv:
        await task.attach_child(conv)

    task_type_id_str = f"task-{task.id}"

    # --- Create Bookmark ---
    nav_path = f"/dock/tasks/{task_type_id_str}"
    notif_title = f"New task from {sender_name}"
    existing_bookmark = await Bookmark.get_one({"title": notif_title, "bookmark_type": BookmarkType.NOTIFICATION})
    if existing_bookmark is None:
        bookmark = Bookmark.model_validate({
            "bookmark_type": BookmarkType.NOTIFICATION,
            "title": notif_title,
            "content": "",
            "status": BookmarkStatus.OPEN,
            "data": {
                "navigation_path": nav_path,
                "task_id": task_id,
                "git_origin": git_origin.model_dump(mode="json") if git_origin else None,
            },
        })
        bookmark.id = Bookmark.allocate_id(bookmark.model_dump())
        await bookmark.save(owner_typeid)

    # Fire in-app WebSocket sync event
    try:
        send_resource_sync(
            type="notification",
            id=task_id,
            operation=SyncOperation.CREATE,
            data={
                "event_data": {
                    "task_type_id": task_type_id_str,
                    "task_id": task_id,
                    "spec_id": spec_id,
                    "spec_type": data.get("spec_type", "plan"),
                    "sender_name": sender_name,
                    "git_origin": git_origin.model_dump(mode="json") if git_origin else None,
                }
            },
        )
    except Exception as e:
        logger.warning(f"notification_scanner: send_resource_sync failed: {e}")

    processed_ids.append(task_id)
    service_log.info(f"notification_scanner: imported task {task_id} from {task_dir.name}")


async def _create_conversation_from_disk(
    task_dir: Path,
    task_id: str,
    conversation_id: str | None,
    owner_typeid,
    notify: bool = True,
    project_id: str | None = None,
    remote_project_id: str | None = None,
    remote_project_name: str | None = None,
    participants: list[dict] | None = None,
    title: str | None = None,
) -> Conversation | None:
    """Create a Conversation entity from conversation.jsonl on disk (recipient side).

    Funnels through ``ensure_conversation_entity`` so sender and recipient
    paths share one creation routine. Runs ``sync_to_db`` so ``message_ids``
    / ``message_count`` reflect what's on disk.

    ``task_dir`` is unused (the canonical jsonl lives under records-data
    root, not the task dir). It is preserved as a parameter for callsite
    back-compat.

    Set notify=False when called from unpack_bundle so the UI doesn't refetch
    the conversation (and try to load referenced FMs) before the FMs
    themselves are saved.
    """
    from flow_sdk.app.actions.materialize_flow_message import ensure_conversation_entity
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
    from flow_sdk.fs_store.operations.conversation import default_jsonl_path, from_jsonl
    from flow_sdk.fs_store.type_id import TypeId

    parent_typeid = TypeId(type=BuiltinEntityType.TASK.value, id=task_id) if task_id else None
    conv_id = conversation_id or Conversation.allocate_id({"task_id": task_id})
    conv = await ensure_conversation_entity(
        conv_id,
        parent_typeid=parent_typeid,
        project_id=project_id,
        remote_project_id=remote_project_id,
        remote_project_name=remote_project_name,
        participants=participants,
        title=title,
        someone_typeid=owner_typeid,
    )

    rec = from_jsonl(
        default_jsonl_path(conv.id), task_id, conv.id
    )
    await rec.sync_to_db(notify=notify)
    return await Conversation.get_one({"id": conv.id})


async def _sync_conversation(task: Task, task_dir: Path) -> None:
    """For an already-imported task, sync conversation.jsonl → Conversation entity."""
    from flow_sdk.fs_store.operations.conversation import default_jsonl_path, from_jsonl

    conv_typeid = task.first_context_of_type("conversation")
    if not conv_typeid:
        return

    conv = await Conversation.get_one({"id": conv_typeid.id})
    if not conv:
        return

    jsonl_path = default_jsonl_path(conv.id)
    if not jsonl_path.exists():
        return

    rec = from_jsonl(jsonl_path, task.id, conv.id)
    await rec.sync_to_db()

    try:
        import asyncio as _asyncio

        from flow_sdk.app.actions.flow_message_action import handle_inbox_fetch
        local_user = await User.get_one({"uname": "local"})
        owner_typeid = local_user.typeid if local_user else None
        if owner_typeid is not None:
            _asyncio.ensure_future(handle_inbox_fetch(str(owner_typeid)))
    except Exception as e:
        logger.warning(f"notification_scanner: schedule inbox-fetch failed (non-fatal): {e}")

    try:
        # Sniffer EVENT — never CRUD. As SyncOperation.UPDATE this reached the
        # webhook receiver's _reflect_entity, which re-saved a stale
        # Conversation snapshot and clobbered the projected message list.
        send_resource_sync(
            type="conversation",
            id=conv.id,
            operation=SyncOperation.EVENT,
            data={
                "event_name": "conversation_updated",
                "event_data": {"task_id": task.id, "conversation_id": conv.id},
            },
        )
    except Exception as e:
        logger.warning(f"notification_scanner: send_resource_sync (conv update) failed: {e}")


async def _create_spec_from_file(spec_file: Path, spec_id: str, owner_typeid) -> Spec | None:
    """Parse spec.md frontmatter + body and save as Spec entity in DB."""
    try:
        raw = spec_file.read_text(encoding="utf-8")
        title = ""
        spec_type = "plan"
        content = raw

        if raw.startswith("---"):
            end = raw.find("---", 3)
            if end != -1:
                fm_block = raw[3:end].strip()
                content = raw[end + 3:].strip()
                for line in fm_block.splitlines():
                    if ":" in line:
                        k, _, v = line.partition(":")
                        k = k.strip()
                        v = v.strip().strip('"')
                        if k == "title":
                            title = v
                        elif k == "spec_type":
                            spec_type = v

        spec = Spec.model_validate({
            "id": spec_id,
            "title": title,
            "content": content,
            "spec_type": spec_type,
        })
        return await spec.save(owner_typeid)
    except Exception as e:
        logger.warning(f"notification_scanner: could not create Spec from {spec_file}: {e}")
        return None
