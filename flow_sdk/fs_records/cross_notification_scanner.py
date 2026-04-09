"""Scanner for incoming cross-user notifications.

On the RECIPIENT side: walks known Claude project roots looking for
tasks/*/manifest.json files that were committed by the sender. If the
manifest identifies this user as the recipient (via sender + notification
data), creates the Task and Spec entities in the local DB.

In the new architecture, notifications are stored in the flowpad.ai cloud.
The scanner falls back to local manifest discovery after a git pull:
  - If a notification_id is present in the manifest, fetch details from cloud
  - Otherwise, use the manifest data directly

Called on: server startup, after git_pull, on-demand via API.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from flow_sdk import service_log
from flow_sdk.builtin.bookmark import Bookmark, BookmarkStatus
from flow_sdk.builtin.spec import Spec
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
from flow_sdk.fs_store import SyncOperation

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
            manifest_file = task_dir / "manifest.json"
            if not manifest_file.exists():
                continue
            try:
                await _process_manifest(manifest_file, task_dir, project_root, local_user_id, processed_ids)
            except Exception as e:
                service_log.error(f"cross_notification_scanner: error processing {manifest_file}: {e}")

    return processed_ids


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

    # Skip if already imported
    existing_task = await Task.get_by_id(task_id)
    if existing_task is not None:
        return

    sender_id = data.get("shared_by_id") or data.get("sender_id")
    sender_name = data.get("sender_name") or "Someone"
    spec_id = data.get("spec_id")
    spec_dir_name = data.get("spec_dir")
    task_title = data.get("title") or "Shared task"

    # Don't import tasks that were created by the local user (sender)
    if sender_id == local_user_id:
        return

    local_user = await User.get_one({"uname": "local"})
    owner_typeid = local_user.typeid if local_user else None

    # --- Create Spec entity from disk ---
    spec_entity = None
    if spec_id and spec_dir_name:
        spec_file = project_root / "tasks" / "spec" / spec_dir_name / "spec.md"
        if spec_file.exists():
            spec_entity = await _create_spec_from_file(spec_file, spec_id, owner_typeid)

    # --- Create Task entity ---
    task = Task.model_validate({
        "id": task_id,
        "title": task_title,
        "spec_id": spec_id,
        "shared_by_id": sender_id,
    })
    task = await task.save(owner_typeid)
    task_type_id_str = f"task-{task.id}"

    # --- Resolve project_url for the consolidated click handler ---
    from flow_sdk.utils.git import git_remote_url
    project_url = git_remote_url(str(project_root))

    # --- Create Bookmark ---
    nav_path = f"/dock/tasks/{task_type_id_str}"
    notif_title = f"New task from {sender_name}"
    existing_bookmark = await Bookmark.get_one({"title": notif_title, "bookmark_type": "notification"})
    if existing_bookmark is None:
        bookmark = Bookmark.model_validate({
            "bookmark_type": "notification",
            "title": notif_title,
            "content": data.get("message") or "",
            "status": BookmarkStatus.OPEN,
            "data": {"navigation_path": nav_path, "task_id": task_id, "project_url": project_url},
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
                }
            },
        )
    except Exception as e:
        logger.warning(f"cross_notification_scanner: send_resource_sync failed: {e}")

    processed_ids.append(task_id)
    service_log.info(f"cross_notification_scanner: imported task {task_id} from {task_dir.name}")


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
        logger.warning(f"cross_notification_scanner: could not create Spec from {spec_file}: {e}")
        return None
