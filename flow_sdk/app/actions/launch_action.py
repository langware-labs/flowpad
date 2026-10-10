"""``POST project/<id>/launch-ensure`` — a launched project, present and checked out HERE.

The USE stage of a launch link ends with "agent + deployed git on a machine"; this is the
deployed-git half for one project, so the SETUP stage starts from a row with a checkout and
nothing else. A launch names its projects by their hub id (the controller and the target the
launch page resolved), so the row is usually missing on a fresh machine: it is mirrored from
the hub first (``Project.hydrate_from_hub``, the same hop a share link takes), then
materialized from its origin in place (``setup_from_git_origin`` — reuses a checkout of the
same repo, indexes it so the agents it ships are rows, resolves its dependencies).

Idempotent: a project already checked out here is returned as is, so the cloud leg — where
the hub provisioned both projects before the browser arrived — passes straight through.
Runs with no local row (``allow_missing_target``): that row is what it is there to fetch.
"""

from __future__ import annotations

import logging
from pathlib import Path

from flow_sdk.actions.action_registry import action
from flow_sdk.builtin.project import Project
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _checked_out(project: Project) -> bool:
    mount = project.fs_storage_mount_path
    return bool(mount) and Path(mount).is_dir()


def _hub_trouble(error: HubError) -> str:
    """Why the hub could not be asked, in the launch dialog's words."""
    if error.status_code == 401:
        return "Your cloud sign-in on this machine has expired. Sign in to the cloud again, then try again."
    if error.status_code == 0:
        return "Couldn't reach the cloud from this machine. Check the connection, then try again."
    return f"The cloud couldn't hand this project over: {error.reason}"


def _setup_trouble(error: Exception) -> str:
    """Why a project the hub handed over could not be checked out here."""
    # A clone's own words (auth, network, a missing repository) are in ``data.detail``.
    detail = str((getattr(error, "data", None) or {}).get("detail") or "").strip()
    return f"Couldn't set up the project: {error}" + (f" — {detail}" if detail else "")


async def ensure_launched_project(project_id: str, someone_typeid: str | None = None) -> Project:
    """The project ``project_id`` names, with a checkout on this machine. Raises
    ``LookupError`` when neither this machine nor the hub (for this caller) has it."""
    project = await Project.get_by_id(project_id)
    if project is None:
        try:
            project = await Project.hydrate_from_hub(project_id, someone_typeid)
        except HubError as e:
            raise LookupError(_hub_trouble(e)) from e
    if project is None:
        raise LookupError("This project isn't available to the account signed in on this machine.")
    if not _checked_out(project):
        project = await project.setup_from_git_origin()
    return project


@action.post(action_name="launch-ensure", types=[BuiltinEntityType.PROJECT.value], allow_missing_target=True)
async def launch_ensure_project() -> ApiResponse:
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        return ApiFailResponse(message="launch-ensure requires a project: project/<id>/launch-ensure", status_code=400)
    project_id = str(request_info.target_entity_typeid.id)
    try:
        project = await ensure_launched_project(project_id, request_info.someone_typeid)
    except LookupError as e:
        return ApiFailResponse(message=str(e), status_code=404)
    except Exception as e:  # noqa: BLE001 — the launch dialog shows a reason, not a stack
        logger.error("[launch] ensure %s failed: %s", project_id, e, exc_info=True)
        return ApiFailResponse(message=_setup_trouble(e), status_code=400)
    return ApiSuccessResponse(data=project)
