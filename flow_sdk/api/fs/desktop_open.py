"""Desktop file/folder opener.

This module provides functionality to open files and folders using the OS default application.
Only available in desktop and local environments for security reasons.
"""

import platform
import subprocess

from .fs_api import EntityFSReqInfo
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.storage import get_entity_storage


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

    try:
        # Determine the command based on the operating system
        system = platform.system()

        if system == "Darwin":  # macOS
            subprocess.run(["open", abs_path], check=True)
        elif system == "Windows":
            # Use 'start' command via cmd
            subprocess.run(["cmd", "/c", "start", "", abs_path], check=True, shell=True)
        elif system == "Linux":
            subprocess.run(["xdg-open", abs_path], check=True)
        else:
            return ApiFailResponse(message=f"Unsupported operating system: {system}")

        # Create a friendly message for the response
        target_name = fs_info.vpath.filename or "folder"
        return ApiSuccessResponse(data=f"Opened {target_name} in default application")

    except subprocess.CalledProcessError as e:
        return ApiFailResponse(message=f"Failed to open file: {str(e)}")
    except FileNotFoundError:
        return ApiFailResponse(message="Required system command not found")
    except Exception as e:
        return ApiFailResponse(message=f"Error opening file: {str(e)}")
