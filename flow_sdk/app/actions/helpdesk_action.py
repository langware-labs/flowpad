"""HTTP actions for the helpdesk PORTAL — the local checkout of a desk's help
content.

Distinct from the ticket queue (``flow_message_action``'s
``helpdesk-start-ticket`` / ``helpdesk-tickets-list``), which talks to the hub.
A desk answers tickets on the hub AND publishes a portal repo that requesters
clone locally; the two are configured separately and either may be absent.

POST /api/v1/graph/helpdesk-status    — where things stand; changes nothing
POST /api/v1/graph/helpdesk-ensure    — checkout exists (clone if missing)
POST /api/v1/graph/helpdesk-refresh   — pull the portal repo
POST /api/v1/graph/helpdesk-reset     — dev: drop the local checkout entirely

``ensure``/``refresh``/``reset`` map 1:1 onto the steps of the UI load flow, so
each renders as one checklist row.
"""

import logging
import os
import shutil
from pathlib import Path
from typing import Optional

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.project import Project
from flow_sdk.config import HELPDESK_PORTAL_UNAME, StorageProvider, helpdesk_project_dir
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.utils.git import git_clone, git_pull

logger = logging.getLogger(__name__)


async def _resolve_target():
    """The desk this instance points at, or ``None`` when the hub has no desk.

    Thin wrapper so every action in this module resolves identically; the real
    chain logic lives in ``flow_message_action.resolve_helpdesk``.
    """
    from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415

    return await resolve_helpdesk()


def _is_checkout(mount_path: Path) -> bool:
    """Whether ``mount_path`` holds a git checkout (as opposed to nothing, or a
    leftover directory from an interrupted clone)."""
    return (mount_path / ".git").is_dir()


async def _find_portal_project(mount: str) -> Optional[Project]:
    """The local Project bound to ``mount``, if it has been materialized."""
    return await Project.find_by_cwd(canonical_posix_path(mount))


@action.post(action_name="helpdesk-status", types=None)
async def helpdesk_status() -> ApiResponse:
    """Read-only view of the desk + its local checkout. Never mutates."""
    try:
        target = await _resolve_target()
        if not target:
            return ApiSuccessResponse(
                data={
                    "helpdesk_project_id": None,
                    "portal_git_url": None,
                    "project_id": None,
                    "mount_path": None,
                    "exists": False,
                }
            )
        mount_path = helpdesk_project_dir(target.project_id)
        mount = str(mount_path)
        exists = _is_checkout(mount_path)
        proj = await _find_portal_project(mount) if exists else None
        return ApiSuccessResponse(
            data={
                "helpdesk_project_id": target.project_id,
                "portal_git_url": target.portal_git_url,
                "project_id": proj.id if proj else None,
                "mount_path": canonical_posix_path(mount),
                "exists": exists,
            }
        )
    except Exception as e:
        logger.error("[helpdesk_action] helpdesk-status error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to read help desk status: {str(e)}")


@action.post(action_name="helpdesk-ensure", types=None)
async def helpdesk_ensure() -> ApiResponse:
    """The portal checkout exists, cloning it on first run. Idempotent.

    Placement is the fixed per-desk slot ``helpdesk_project_dir`` — NOT
    ``GitOrigin.next_clone_target``. The portal is app-managed infrastructure
    keyed by desk id, not a user project the recipient chose to take, so it must
    land in the same deterministic spot every time (which is also what lets
    ``helpdesk-reset`` know exactly what to remove).
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        target = await _resolve_target()
        if not target:
            # No desk at all — genuinely an error, and the only one here.
            return ApiFailResponse(message="Help desk is unavailable on this hub", status_code=502)
        if not target.portal_git_url:
            # A desk with a ticket queue and NO portal is a valid configuration
            # (see HelpdeskConfig) — and it is also what an older hub looks like,
            # since it advertises no portal url at all. Report it as a SUCCESS
            # carrying ``has_portal: false`` so the caller can degrade to the
            # ticket flow; failing here would make the whole help desk
            # unreachable on any hub that predates the portal field.
            return ApiSuccessResponse(
                data={
                    "project_id": None,
                    "helpdesk_project_id": target.project_id,
                    "mount_path": None,
                    "cloned": False,
                    "has_portal": False,
                }
            )

        mount_path = helpdesk_project_dir(target.project_id)
        mount = str(mount_path)
        cloned = False

        if not _is_checkout(mount_path):
            # A leftover non-repo dir (interrupted clone) would make git refuse
            # to clone into it, and would keep failing on every retry.
            if mount_path.exists():
                shutil.rmtree(mount, ignore_errors=True)
            mount_path.parent.mkdir(parents=True, exist_ok=True)

            token = None
            try:
                from flow_sdk.app.actions.oauth_action import (  # noqa: PLC0415
                    _get_github_token_for_current_user,
                )

                token, _ = await _get_github_token_for_current_user()
            except Exception:  # noqa: BLE001
                # The portal is expected to be public; a missing token is normal.
                token = None

            ok, message = await git_clone(target.portal_git_url, mount, token=token)
            if not ok:
                return ApiFailResponse(message=message, status_code=502)
            cloned = True

        canonical = canonical_posix_path(mount)
        proj = await _find_portal_project(mount)
        if proj is None:
            origin = GitOrigin.from_url(target.portal_git_url, rel_path=".")
            proj = Project(
                type="project",
                # Stable uname so any surface can recognise the portal from the
                # entity it already holds — no probe. Hiddenness is NOT stamped
                # here: `is_hidden_project` derives it from the location
                # (`is_helpdesk_portal_path`), which also covers rows minted by
                # the per-cwd project walk.
                uname=HELPDESK_PORTAL_UNAME,
                name="Help Desk",
                fs_storage_mount_path=canonical,
                fs_storage_provider=StorageProvider.LOCAL.value,
                visitor_role="owner",
                git_origin=origin,
            )
            await proj.save(request_info.someone_typeid)
            # Mirrors `_ensure_system_projects`: the field alone does not
            # establish the role, so the app-managed-project recipe saves AND
            # then applies it.
            await proj.set_visitor_role("owner")

        return ApiSuccessResponse(
            data={
                "project_id": proj.id,
                "helpdesk_project_id": target.project_id,
                "mount_path": canonical,
                "cloned": cloned,
                "has_portal": True,
            }
        )
    except Exception as e:
        logger.error("[helpdesk_action] helpdesk-ensure error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to prepare the help desk: {str(e)}")


@action.post(action_name="helpdesk-refresh", types=None)
async def helpdesk_refresh() -> ApiResponse:
    """Pull the portal repo so local help content matches the remote."""
    try:
        target = await _resolve_target()
        if not target:
            return ApiFailResponse(message="Help desk is unavailable on this hub", status_code=502)

        mount = str(helpdesk_project_dir(target.project_id))
        if not _is_checkout(mount_path):
            return ApiFailResponse(message="Help desk files are not set up yet", status_code=409)

        ok, message = await git_pull(mount)
        if not ok:
            return ApiFailResponse(message=message, status_code=502)
        # git says "Already up to date." when the pull was a no-op; anything
        # else means refs moved.
        return ApiSuccessResponse(data={"updated": "up to date" not in message.lower(), "message": message})
    except Exception as e:
        logger.error("[helpdesk_action] helpdesk-refresh error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to refresh the help desk: {str(e)}")


@action.post(action_name="helpdesk-reset", types=None)
async def helpdesk_reset() -> ApiResponse:
    """Drop the local portal entirely so the next open re-clones from scratch.

    Local only — the hub desk and its tickets are untouched. Deletes the Project
    entity, its child entities, and the on-disk folder via
    ``Project._delete_with_children``; the folder lives under the workspace, so
    it is neither protected nor SDK-shipped and really is removed. Exposed in
    the UI behind a dev-mode gate.
    """
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="No authenticated user in request context")

        target = await _resolve_target()
        if not target:
            return ApiFailResponse(message="Help desk is unavailable on this hub", status_code=502)

        mount = str(helpdesk_project_dir(target.project_id))
        canonical = canonical_posix_path(mount)
        proj = await _find_portal_project(mount)
        if proj is not None:
            await proj._delete_with_children()

        # Belt to the entity delete's braces: with no Project row (e.g. a clone
        # that failed before the entity was saved) nothing above touches disk,
        # and the stale folder would make the next `ensure` skip its clone.
        if os.path.isdir(mount):
            shutil.rmtree(mount, ignore_errors=True)

        return ApiSuccessResponse(data={"deleted": True, "mount_path": canonical})
    except Exception as e:
        logger.error("[helpdesk_action] helpdesk-reset error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed to reset the help desk: {str(e)}")
