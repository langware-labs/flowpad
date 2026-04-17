"""Action handlers for the recipient side of shared tasks.

Three endpoints, all scoped to the Task entity that was created by the
notification scanner when the manifest arrived:

  POST /api/v1/graph/task/{task_id}/find-project
  POST /api/v1/graph/task/{task_id}/pull-for-task
  POST /api/v1/graph/task/{task_id}/clone-for-task
"""

import asyncio
import logging

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.task import Task
from flow_sdk.builtin.user import User
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse, ApiResponse

logger = logging.getLogger(__name__)


async def _get_task(task_id: str) -> Task | None:
    return await Task.get_one({"id": task_id})


@action.post(action_name="find-project", types=["task"])
async def find_project_for_task() -> ApiResponse:
    """Determine whether the task's source repo exists locally.

    Returns:
      found (bool)          — True if a local clone was found
      local_path (str|null) — filesystem path to the clone
      repo_url (str)        — origin URL of the repo
      branch (str)          — branch from manifest
      known_projects (list) — [{name, path}] for all known local Claude projects
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")

        task_id = str(request_info.target_entity_typeid.id)
        task = await _get_task(task_id)

        body = await request_info.get_post_data() or {}
        meta = (task.metadata or {}) if task else {}

        # Use task metadata if available, fall back to body params (deep-link before scanner has run)
        project_url = meta.get("project_url") or (body.get("project_url") or "").strip()
        manifest_repo_id = meta.get("repo_id") or (body.get("repo_id") or "").strip()
        branch = meta.get("branch") or (body.get("branch") or "").strip()

        from flow_sdk.utils.git import (
            find_local_repo_for_url,
            git_repo_full_name,
            repo_id,
        )
        from flow_sdk.fs_records._claude_projects import iter_claude_project_paths

        # Build the list of all known local projects
        known_projects: list[dict] = []
        for project_root in iter_claude_project_paths():
            try:
                full_name = git_repo_full_name(str(project_root))
                known_projects.append({
                    "name": full_name or project_root.name,
                    "path": str(project_root),
                })
            except Exception:
                known_projects.append({"name": project_root.name, "path": str(project_root)})

        # Pass 1: match by repo_id (uuid5 of repo full name)
        local_path: str | None = None
        if manifest_repo_id:
            for project_root in iter_claude_project_paths():
                try:
                    full_name = git_repo_full_name(str(project_root))
                    if full_name and repo_id(full_name) == manifest_repo_id:
                        local_path = str(project_root)
                        break
                except Exception:
                    continue

        # Pass 2: fall back to URL match
        if not local_path and project_url:
            local_path = find_local_repo_for_url(project_url)

        return ApiSuccessResponse(data={
            "found": bool(local_path),
            "local_path": local_path,
            "repo_url": project_url,
            "branch": branch,
            "known_projects": known_projects,
        })
    except Exception as e:
        logger.error(f"[task_receive] find-project error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to find project: {str(e)}")


@action.post(action_name="pull-for-task", types=["task"])
async def pull_for_task() -> ApiResponse:
    """Git pull the task's source repo and re-scan for incoming notifications.

    Body (optional):
      local_path (str) — override the repo path (defaults to task metadata lookup)

    Returns:
      success (bool)
      conflicts (bool)
      error (str|null)
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")

        task_id = str(request_info.target_entity_typeid.id)
        task = await _get_task(task_id)

        body = await request_info.get_post_data() or {}
        meta = (task.metadata or {}) if task else {}
        branch = meta.get("branch") or (body.get("branch") or "").strip()
        project_url = meta.get("project_url") or (body.get("project_url") or "").strip()

        # Determine local_path: from body override, then metadata, then URL lookup
        local_path: str | None = (body.get("local_path") or "").strip() or None
        if not local_path:
            local_path = meta.get("project_root") or None
        if not local_path and project_url:
            from flow_sdk.utils.git import find_local_repo_for_url
            local_path = find_local_repo_for_url(project_url)

        if not local_path:
            return ApiFailResponse(message="No local repo path found for this task")

        from flow_sdk.utils.git import git_pull
        pull_ok, pull_msg = await git_pull(local_path, branch=branch or None)

        conflicts = "CONFLICT" in (pull_msg or "")

        # Await scan of this specific task so the entity exists before the UI navigates.
        # Then fire the full scan in the background for any other tasks in the repo.
        try:
            from flow_sdk.fs_records.notification_scanner import scan_task_in_repo, scan_incoming_notifications
            local_user = await User.get_one({"uname": "local"})
            if local_user:
                await scan_task_in_repo(local_user.id, local_path, task_id)
                asyncio.ensure_future(scan_incoming_notifications(local_user.id))
        except Exception as scan_err:
            logger.warning(f"[task_receive] pull-for-task: scan error (non-fatal): {scan_err}")

        return ApiSuccessResponse(data={
            "success": pull_ok and not conflicts,
            "conflicts": conflicts,
            "error": None if pull_ok else pull_msg,
        })
    except Exception as e:
        logger.error(f"[task_receive] pull-for-task error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to pull: {str(e)}")


@action.post(action_name="clone-for-task", types=["task"])
async def clone_for_task() -> ApiResponse:
    """Clone the task's source repo into a chosen directory.

    Body:
      target_dir (str) — directory to clone into

    Returns:
      success (bool)
      error (str|null)
      cloned_path (str|null)
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.target_entity_typeid:
            return ApiFailResponse(message="No request info found")

        task_id = str(request_info.target_entity_typeid.id)
        task = await _get_task(task_id)

        body = await request_info.get_post_data() or {}
        target_dir = (body.get("target_dir") or "").strip()
        if not target_dir:
            return ApiFailResponse(message="target_dir is required")

        meta = (task.metadata or {}) if task else {}
        project_url = meta.get("project_url") or (body.get("project_url") or "").strip()
        branch = meta.get("branch") or (body.get("branch") or "").strip()

        if not project_url:
            return ApiFailResponse(message="No project URL found for this task")

        # Derive repo name from URL (e.g. "https://github.com/org/my-repo.git" → "my-repo")
        # and clone into <target_dir>/<repo-name> so the user picks a parent folder.
        import re as _re
        from pathlib import Path as _Path
        repo_name_match = _re.search(r'/([^/]+?)(?:\.git)?$', project_url)
        repo_name = repo_name_match.group(1) if repo_name_match else "repo"
        clone_path = str(_Path(target_dir) / repo_name)

        from flow_sdk.utils.git import git_clone, git_pull
        clone_ok, clone_msg = await git_clone(project_url, clone_path, branch=branch or None)

        # If clone failed because the directory already exists, pull instead.
        if not clone_ok and "already exists and is not an empty directory" in clone_msg:
            logger.info("[task_receive] clone target exists — attempting pull instead: %s", clone_path)
            pull_ok, pull_msg = await git_pull(clone_path, branch=branch or None)
            conflicts = "CONFLICT" in (pull_msg or "")
            op_ok = pull_ok and not conflicts
            if op_ok or conflicts:
                clone_ok, clone_msg = op_ok, pull_msg
                if conflicts:
                    return ApiSuccessResponse(data={
                        "success": False,
                        "conflicts": True,
                        "error": None,
                        "cloned_path": clone_path,
                    })

        # Await scan of this specific task so the entity exists before the UI navigates.
        # Then fire the full scan in the background for any other tasks in the repo.
        if clone_ok:
            try:
                from flow_sdk.fs_records.notification_scanner import scan_task_in_repo, scan_incoming_notifications
                local_user = await User.get_one({"uname": "local"})
                if local_user:
                    await scan_task_in_repo(local_user.id, clone_path, task_id)
                    asyncio.ensure_future(scan_incoming_notifications(local_user.id))
            except Exception as scan_err:
                logger.warning(f"[task_receive] clone-for-task: scan error (non-fatal): {scan_err}")

        return ApiSuccessResponse(data={
            "success": clone_ok,
            "conflicts": False,
            "error": None if clone_ok else clone_msg,
            "cloned_path": clone_path if clone_ok else None,
        })
    except Exception as e:
        logger.error(f"[task_receive] clone-for-task error: {e}", exc_info=True)
        return ApiFailResponse(message=f"Failed to clone: {str(e)}")


