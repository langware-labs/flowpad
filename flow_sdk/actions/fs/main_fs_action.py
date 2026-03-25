"""Main filesystem action dispatcher.

Ported from FlowPad: flowpad/hub/app/actions/fs/main_fs_action.py

Dispatches filesystem requests to appropriate handler based on fs_action parameter.
"""

import logging
import traceback
from typing import Any

from starlette.responses import StreamingResponse

from flow_sdk.api.fs.desktop_open import open_in_os
from flow_sdk.api.fs.fs_api import allowed_fs_actions, get_request_fs_info
from flow_sdk.actions import action
from flow_sdk.request_context import get_current_request_info
from flow_sdk.responses import ApiFailResponse, ApiResponse, ApiSuccessResponse
from .fs_actions import (
    browse,
    copy,
    create_symlink,
    delete,
    download,
    download_zip,
    mkdir,
    move,
    rename,
    resolve_symlink,
    upload,
    upload_zip,
    write,
)

logger = logging.getLogger(__name__)


@action.all(action_name="fs")
async def fs() -> ApiResponse[Any] | StreamingResponse:
    """Main filesystem action handler.

    Routes requests based on fs_action parameter to appropriate operation handler.

    Supported fs_actions:
    - browse: List directory contents
    - upload: Upload files
    - download: Download file
    - download_zip: Download directory as zip
    - upload_zip: Upload zip file
    - delete: Delete file/folder
    - rename: Rename file/folder
    - copy: Copy file/folder
    - move: Move file/folder
    - mkdir: Create directory
    - write: Write file content
    - create_symlink: Create symbolic link
    - resolve_symlink: Resolve symlink target
    """
    fs_info = None
    try:
        current_request_info = get_current_request_info()
        if not current_request_info:
            return ApiFailResponse(message="FS error, No request info")

        fs_info = get_request_fs_info()
        if fs_info.fs_action not in allowed_fs_actions:
            return ApiFailResponse(message=f"Action {fs_info.fs_action} is not allowed")
        if not fs_info.vpath:
            return ApiFailResponse(message="FS error, No entity app path")

        # Dispatch to appropriate handler
        if fs_info.fs_action == "browse":
            return await browse(current_request_info, fs_info)
        elif fs_info.fs_action == "upload":
            return await upload(current_request_info, fs_info)
        elif fs_info.fs_action == "download":
            return await download(current_request_info, fs_info)
        elif fs_info.fs_action == "download_zip":
            return await download_zip(current_request_info, fs_info)
        elif fs_info.fs_action == "upload_zip":
            return await upload_zip(current_request_info, fs_info)
        elif fs_info.fs_action == "delete":
            return await delete(current_request_info, fs_info)
        elif fs_info.fs_action == "rename":
            return await rename(current_request_info, fs_info)
        elif fs_info.fs_action == "copy":
            return await copy(current_request_info, fs_info)
        elif fs_info.fs_action == "move":
            return await move(current_request_info, fs_info)
        elif fs_info.fs_action == "mkdir":
            return await mkdir(current_request_info, fs_info)
        elif fs_info.fs_action == "write":
            return await write(current_request_info, fs_info)
        elif fs_info.fs_action == "open":
            return await open_in_os(current_request_info, fs_info)
        elif fs_info.fs_action == "create_symlink":
            return await create_symlink(current_request_info, fs_info)
        elif fs_info.fs_action == "resolve_symlink":
            return await resolve_symlink(current_request_info, fs_info)
        else:
            return ApiSuccessResponse(data=[])

    except RuntimeError as e:
        msg = f"FS error: {e.args[0] if e.args else str(e)}"
        if fs_info is not None:
            msg += f" {fs_info}"
        logger.error(msg)
        return ApiFailResponse(message=msg)
    except Exception as e:
        msg = f"FS error: {str(e)}"
        if fs_info is not None:
            msg += f" {fs_info}"
        logger.error(msg)
        logger.debug(f"FS error stack: {traceback.format_exc()}")
        return ApiFailResponse(message=msg)
