"""Screen recordings — where the top bar's Record button puts a recording, and how it
moves into a project.

  GET  /api/v1/graph/recording-folder
  POST /api/v1/graph/recording-save-to-project   {name, project_id}

The renderer records with ``getDisplayMedia`` + ``MediaRecorder`` and uploads the WebM
through the generic ``fs`` upload into the folder the first action names:
``<FLOWPAD_TEMP_DIR>/<instance>/recordings/``. The answer has the same shape as a
process's ``input-dir`` (``{abs_path, compute_node_id}``) so the upload path in the UI is
the one attachments already use. The renderer never spells a backend path itself, and
never sends one back: "Save to project" names the recording by its FILE NAME, and the
backend resolves both ends — the temp folder it came from and ``<project>/recordings/``
from the project's own folder — then moves, indexes, and answers with the new location.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from pydantic import ValidationError

from flow_sdk.actions.action_registry import action
from flow_sdk.config import instance_temp_dir
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)

RECORDINGS_DIR_NAME = "recordings"


class SaveRecordingRequest(DataSpec):
    """``POST /api/v1/graph/recording-save-to-project`` body: which recording, into which project."""

    name: str
    project_id: str


def recordings_temp_folder() -> Path:
    """This instance's recordings in Flowpad's TEMP folder (not created here)."""
    return instance_temp_dir(RECORDINGS_DIR_NAME)


_local_node: str | None = None


async def local_compute_node_typeid() -> str:
    """The VFS TypeId of this machine's compute node, ``compute_node-@local`` when none is registered.

    Fixed for the life of the process, so one lookup serves every later call.
    """
    global _local_node  # noqa: PLW0603
    if _local_node is None:
        from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

        node = await ComputeNode.get_local()
        if node is None:
            return "compute_node-@local"
        _local_node = f"compute_node-{node.id}"
    return _local_node


async def _place_answer(abs_path: Path) -> ApiResponse:
    return ApiSuccessResponse(data={"abs_path": str(abs_path), "compute_node_id": await local_compute_node_typeid()})


@action.get(action_name="recording-folder", types=None)
async def recording_folder_action() -> ApiResponse:
    """Where a new screen recording is uploaded: the recordings temp folder, created if needed."""
    folder = recordings_temp_folder()
    folder.mkdir(parents=True, exist_ok=True)
    return await _place_answer(folder)


def move_recording_into_project(name: str, project_folder: Path) -> Path:
    """Move the recording ``name`` from the temp folder under ``<project_folder>/recordings/``.

    Pure filesystem work, kept apart from the action so a test can run it on a temp tree.
    ``name`` is a bare file name — a path (or ``..``) is refused, so the action can only ever
    reach the folder it owns — and a destination that already exists is refused too, so a
    re-click cannot overwrite a saved recording.
    """
    if not name or Path(name).name != name or name in (".", ".."):
        raise PermissionError(f"not a recording name: {name!r}")
    source = recordings_temp_folder() / name
    if not source.is_file():
        raise FileNotFoundError(f"no recording {name!r} in {source.parent}")
    dest_dir = project_folder / RECORDINGS_DIR_NAME
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / name
    if dest.exists():
        raise FileExistsError(f"already in the project: {dest}")
    shutil.move(str(source), str(dest))
    return dest


@action.post(action_name="recording-save-to-project", types=None)
async def save_recording_to_project_action() -> ApiResponse:
    """Move a recording from the temp folder into ``<project>/recordings/`` and index it."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info:
        return ApiFailResponse(message="No request info found", status_code=400)
    try:
        body = SaveRecordingRequest.model_validate(await request_info.get_post_data() or {})
    except ValidationError as e:
        return ApiFailResponse(message=f"Invalid save request: {e}", status_code=400)

    project = await Project.get_by_id(body.project_id)
    if project is None or not project.fs_storage_mount_path:
        return ApiFailResponse(message=f"Project {body.project_id} has no folder on this machine", status_code=404)

    try:
        dest = move_recording_into_project(body.name, Path(project.fs_storage_mount_path))
    except PermissionError as e:
        return ApiFailResponse(message=str(e), status_code=403)
    except FileNotFoundError as e:
        return ApiFailResponse(message=str(e), status_code=404)
    except FileExistsError as e:
        return ApiFailResponse(message=str(e), status_code=409)

    # Awaited, not scheduled: the toast's Open follows at once, and the viewer wants the row.
    try:
        from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415

        await reindex_paths([str(dest)])
    except Exception as e:  # noqa: BLE001 — the move succeeded; the indexer's sweep will catch up
        logger.warning("[recording] index after move skipped (non-fatal): %s", e)

    return await _place_answer(dest)
