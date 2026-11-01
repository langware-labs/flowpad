"""Desktop file/folder opener.

This module provides functionality to open files and folders using the OS default application.
Only available in desktop and local environments for security reasons.
"""

import os
import platform
import subprocess

from .fs_api import EntityFSReqInfo
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.storage import get_entity_storage


def os_open_command(system: str, abs_path: str, *, reveal: bool = False) -> list[str] | None:
    """The command that opens ``abs_path`` — or, with ``reveal``, shows it selected in the
    OS file manager. None for an OS we have no opener for."""
    if system == "Darwin":
        return ["open", "-R", abs_path] if reveal else ["open", abs_path]
    if system == "Windows":
        return ["explorer", f"/select,{abs_path}"] if reveal else ["cmd", "/c", "start", "", abs_path]
    if system == "Linux":
        # No portable "select this file" on Linux: open the containing folder.
        return ["xdg-open", os.path.dirname(abs_path.rstrip("/")) or "/"] if reveal else ["xdg-open", abs_path]
    return None


async def open_in_os(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[str]:
    """Open a file or folder using the OS default application.

    This action is only available in desktop and local environments.
    Uses the OS default handler to open files/folders:
    - Windows: 'start'
    - macOS: 'open'
    - Linux: 'xdg-open'

    Args:
        request_info: Request context information
        fs_info: Filesystem request information containing the path

    Returns:
        Success response with message or failure response with error
    """
    # For now, allow all environments - restriction can be added later
    # if not (default_service_config.is_desktop or default_service_config.is_local):
    #     return ApiFailResponse(
    #         message="Open action is only available in desktop and local environments",
    #         status_code=404,
    #     )

    if request_info.method != "get":
        return ApiFailResponse(message="Open action requires GET method")

    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Open action requires typeid")

    entity = await request_info.get_target_entity()
    if entity is None:
        return ApiFailResponse(message="Target entity not found")

    storage = get_entity_storage(fs_info.vpath.typeid, entity=entity)

    # Check if path exists
    if not await storage.exists(fs_info.abs_path):
        return ApiFailResponse(message="File or folder not found", status_code=404)

    # Get the actual filesystem path from the storage driver
    # Both LocalStorageDriver and SandboxStorageDriver (in local mode) support get_storage_path
    abs_path = storage.get_storage_path(fs_info.abs_path)

    reveal = (request_info.request.query_params.get("reveal") or "").lower() in ("1", "true", "yes")
    try:
        cmd = os_open_command(platform.system(), abs_path, reveal=reveal)
        if cmd is None:
            return ApiFailResponse(message=f"Unsupported operating system: {platform.system()}")
        # Explorer's /select exits non-zero even when it worked, so its result is not checked.
        subprocess.run(cmd, check=not (reveal and platform.system() == "Windows"))

        # Create a friendly message for the response
        target_name = fs_info.vpath.filename or "folder"
        if reveal:
            return ApiSuccessResponse(data=f"Revealed {target_name}")
        return ApiSuccessResponse(data=f"Opened {target_name} in default application")

    except subprocess.CalledProcessError as e:
        return ApiFailResponse(message=f"Failed to open file: {str(e)}")
    except FileNotFoundError:
        return ApiFailResponse(message="Required system command not found")
    except Exception as e:
        return ApiFailResponse(message=f"Error opening file: {str(e)}")
