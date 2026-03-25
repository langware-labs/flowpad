"""Filesystem action implementations.

Ported from FlowPad: flowpad/hub/app/actions/fs/fs_actions.py

Implements individual filesystem operations (browse, upload, download, delete, etc.)
"""

import errno
import json
import logging
import mimetypes
import re
import urllib.parse
from io import BytesIO
from typing import AsyncIterator, List

from starlette.datastructures import UploadFile
from starlette.responses import StreamingResponse

from flow_sdk.api.fs.fs_api import EntityFSReqInfo, VFSPath
from flow_sdk.models import FSItem
from flow_sdk.request_context.request_info import RequestInfo
from flow_sdk.responses import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.storage import LocalStorageDriver, StoragePermissionError, get_entity_storage

logger = logging.getLogger(__name__)


def _is_permission_denied_error(error: Exception) -> bool:
    """Detect permission-denied errors wrapped by storage or OS layers."""
    if isinstance(error, (PermissionError, StoragePermissionError)):
        return True

    if isinstance(error, OSError) and getattr(error, "errno", None) in (errno.EACCES, errno.EPERM, errno.ENOTSUP):
        return True

    # Check wrapped cause (e.g. StorageError wrapping an OSError)
    cause = getattr(error, "__cause__", None) or getattr(error, "__context__", None)
    if isinstance(cause, OSError) and getattr(cause, "errno", None) in (errno.EACCES, errno.EPERM, errno.ENOTSUP):
        return True

    msg = str(error).lower()
    return "permission denied" in msg or "operation not permitted" in msg or "operation not supported" in msg


def _permission_denied_response(vfs_path: str | None) -> ApiFailResponse:
    path = "/" + str(vfs_path).lstrip("/") if vfs_path else "/"
    return ApiFailResponse(
        message=f"Not allowed: you do not have permission to access '{path}'.",
        status_code=403,
    )


def make_content_disposition(filename: str, inline: bool = False) -> str:
    """Create Content-Disposition header value for file download.

    Args:
        filename: Filename to encode
        inline: If True, use 'inline' disposition (browser renders the file);
                if False (default), use 'attachment' (browser downloads the file).

    Returns:
        Content-Disposition header value
    """
    disposition = "inline" if inline else "attachment"
    ascii_fallback = re.sub(r"[^\x20-\x7E]", "_", filename)
    utf8_quoted = urllib.parse.quote(filename, safe="")
    return f"{disposition}; filename=\"{ascii_fallback}\"; filename*=UTF-8''{utf8_quoted}"


def _get_media_type(filename: str) -> str:
    """Detect MIME type from filename extension.

    Returns the correct content-type (e.g. 'image/png') or falls back to
    'application/octet-stream' for unknown types.
    """
    mime, _ = mimetypes.guess_type(filename)
    return mime or "application/octet-stream"


async def _get_storage_for_entity(request_info: RequestInfo) -> LocalStorageDriver:
    """Get storage driver for entity.

    Uses get_entity_storage() which respects entity's fs_storage_provider
    and fs_storage_mount_path configuration.

    Args:
        request_info: Current request info

    Returns:
        LocalStorageDriver instance for the entity

    Raises:
        RuntimeError: If entity not found
    """
    target_entity = request_info.target_entity_typeid
    if not target_entity:
        raise RuntimeError("No target entity found in request info")

    # Get entity from auth_result if available (has fs_storage config)
    entity = None
    if request_info.auth_result and request_info.auth_result.target:
        auth_target = request_info.auth_result.target
        auth_target_typeid = getattr(auth_target, "typeid", None)
        if auth_target_typeid and str(auth_target_typeid) == str(target_entity):
            entity = auth_target

    # Fallback to explicit target entity lookup when auth target is missing/mismatched.
    if entity is None:
        try:
            entity = await request_info.get_target_entity()
        except Exception as e:
            logger.debug(f"Failed to fetch target entity for storage resolution: {e}")

    # Use entity_storage_service which respects fs_storage_provider/fs_storage_mount_path
    return get_entity_storage(target_entity, entity=entity)


async def browse(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[List[FSItem]]:
    """List directory contents.

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with action and path

    Returns:
        ApiResponse with list of FSItem objects

    Raises:
        FileNotFoundError: If directory doesn't exist
    """
    if not request_info.is_get:
        return ApiFailResponse(message="Browse action requires GET method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Browse action requires typeid")

    try:
        storage = await _get_storage_for_entity(request_info)
        items = await storage.list_dir(fs_info.vpath.abs_vfspath)
        return ApiSuccessResponse(data=items)
    except FileNotFoundError as e:
        logger.error(f"Browse error: {e}")
        return ApiFailResponse(message=f"Directory not found: {str(e)}", status_code=404)
    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Browse permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Browse error: {e}")
        return ApiFailResponse(message=f"Failed to browse directory: {str(e)}")


async def download(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> StreamingResponse | ApiFailResponse:
    """Download file.

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with file path

    Returns:
        StreamingResponse with file contents or error response
    """
    if not request_info.is_get:
        return ApiFailResponse(message="Download action requires GET method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Download action requires typeid")

    try:
        storage = await _get_storage_for_entity(request_info)

        # Check if file exists
        if not await storage.exists(fs_info.vpath.abs_vfspath):
            return ApiFailResponse(message="File not found", status_code=404)

        # Stream file
        stream: AsyncIterator[bytes] = storage.stream(fs_info.vpath.abs_vfspath)
        filename = fs_info.vpath.filename
        media_type = _get_media_type(filename)
        # Use inline disposition for images so browsers can render them in <img> tags
        is_inline = media_type.startswith("image/")
        headers = {
            "Content-Disposition": make_content_disposition(filename, inline=is_inline),
        }
        return StreamingResponse(
            content=stream,
            media_type=media_type,
            headers=headers,
        )
    except FileNotFoundError:
        return ApiFailResponse(message="File not found", status_code=404)
    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Download permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Download error: {e}")
        return ApiFailResponse(message=f"Failed to download file: {str(e)}")


async def upload(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[List[FSItem]]:
    """Upload files.

    Args:
        request_info: Current request info with uploaded files
        fs_info: Filesystem request info with destination path

    Returns:
        ApiResponse with list of uploaded FSItem objects
    """
    if not request_info.is_post:
        return ApiFailResponse(message="Upload action requires POST method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Upload action requires typeid")

    try:
        # Get uploaded files from already-parsed request data
        # (request body is consumed by graph route's get_post_data() before action runs)
        files: List[UploadFile] = []
        post_data = await request_info.get_post_data()
        if isinstance(post_data, dict):
            for field_value in post_data.values():
                if isinstance(field_value, UploadFile):
                    files.append(field_value)
                elif isinstance(field_value, list):
                    files.extend(v for v in field_value if isinstance(v, UploadFile))
        if not files:
            # Fallback: try reading form directly (for cases where body wasn't pre-parsed)
            form = await request_info.request.form()
            for field_value in form.values():
                if isinstance(field_value, UploadFile):
                    files.append(field_value)

        if not files:
            return ApiFailResponse(message="No files found in request")

        storage = await _get_storage_for_entity(request_info)
        uploaded_items = []

        for file in files:
            if not file.filename:
                return ApiFailResponse(message="Upload error: No filename")

            # Build destination path
            dest_path = fs_info.vpath.abs_vfspath.rstrip("/") + "/" + file.filename

            # Read file content
            content = await file.read()

            # Upload file
            await storage.upload(BytesIO(content), dest_path)

            # Create FSItem for response
            fs_item = FSItem(
                vfs_abs_path=dest_path,
                is_dir=False,
                size=len(content),
                display_name=file.filename,
            )
            uploaded_items.append(fs_item)
            logger.debug(f"Uploaded file {file.filename} to {dest_path}")

        return ApiSuccessResponse(data=uploaded_items)

    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Upload permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Upload error: {e}")
        return ApiFailResponse(message=f"Failed to upload files: {str(e)}")


async def delete(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[dict]:
    """Delete file or folder.

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with path to delete

    Returns:
        ApiResponse with success/error status
    """
    if not request_info.is_delete:
        return ApiFailResponse(message="Delete action requires DELETE method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Delete action requires typeid")

    try:
        storage = await _get_storage_for_entity(request_info)

        # Check if path exists
        if not await storage.exists(fs_info.vpath.abs_vfspath):
            return ApiFailResponse(message="Path not found", status_code=404)

        # Delete
        await storage.delete(fs_info.vpath.abs_vfspath)
        return ApiSuccessResponse(data={"message": "Deleted successfully"})

    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Delete permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Delete error: {e}")
        return ApiFailResponse(message=f"Failed to delete: {str(e)}")


async def mkdir(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSItem]:
    """Create directory.

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with directory path

    Returns:
        ApiResponse with FSItem for new directory
    """
    if not request_info.is_post:
        return ApiFailResponse(message="Mkdir action requires POST method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Mkdir action requires typeid")

    try:
        storage = await _get_storage_for_entity(request_info)

        # Check if path already exists
        if await storage.exists(fs_info.vpath.abs_vfspath):
            return ApiFailResponse(message="Path already exists", status_code=409)

        # Create directory
        await storage.create_folder(fs_info.vpath.abs_vfspath)

        # Return FSItem
        fs_item = FSItem(
            vfs_abs_path=fs_info.vpath.abs_vfspath,
            is_dir=True,
            display_name=fs_info.vpath.filename,
        )
        return ApiSuccessResponse(data=fs_item)

    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Mkdir permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Mkdir error: {e}")
        return ApiFailResponse(message=f"Failed to create directory: {str(e)}")


async def write(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSItem]:
    """Write content to file.

    Args:
        request_info: Current request info with file content in body
        fs_info: Filesystem request info with file path

    Returns:
        ApiResponse with FSItem for written file
    """
    if not request_info.is_post:
        return ApiFailResponse(message="Write action requires POST method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Write action requires typeid")

    try:
        # Get content from request body
        body = await request_info.request.body()
        content = ""
        if body:
            try:
                json_body = json.loads(body.decode("utf-8"))
                if isinstance(json_body, dict) and "content" in json_body:
                    content = json_body["content"]
                else:
                    content = body.decode("utf-8")
            except (json.JSONDecodeError, UnicodeDecodeError):
                content = body.decode("utf-8", errors="replace")

        if not body:
            return ApiFailResponse(message="Write action requires content in request body")

        storage = await _get_storage_for_entity(request_info)

        # Write file
        content_bytes = content.encode("utf-8") if isinstance(content, str) else content
        await storage.upload(BytesIO(content_bytes), fs_info.vpath.abs_vfspath)

        # Return FSItem
        fs_item = FSItem(
            vfs_abs_path=fs_info.vpath.abs_vfspath,
            is_dir=False,
            size=len(content_bytes),
            display_name=fs_info.vpath.filename,
        )
        return ApiSuccessResponse(data=fs_item)

    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Write permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Write error: {e}")
        return ApiFailResponse(message=f"Failed to write file: {str(e)}")


async def rename(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSItem]:
    """Rename file or folder.

    Query parameter:
    - new_name: New name (without path separators)

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with path

    Returns:
        ApiResponse with FSItem for renamed item
    """
    if not request_info.is_post:
        return ApiFailResponse(message="Rename action requires POST method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Rename action requires typeid")

    new_name = request_info.request.query_params.get("new_name")
    if not new_name:
        return ApiFailResponse(message="'new_name' query parameter required")
    if "/" in new_name or "\\" in new_name:
        return ApiFailResponse(message="New name cannot contain path separators")

    try:
        storage = await _get_storage_for_entity(request_info)

        # Check source exists
        if not await storage.exists(fs_info.vpath.abs_vfspath):
            return ApiFailResponse(message="Source not found", status_code=404)

        # Calculate destination path
        source_parts = fs_info.vpath.entity_sub_path.rstrip("/").split("/")
        parent = "/".join(source_parts[:-1]) if len(source_parts) > 1 else ""
        dest_sub_path = f"{parent}/{new_name}" if parent else new_name
        dest_vpath = VFSPath.from_entity_path(fs_info.vpath.typeid, dest_sub_path)

        # Rename (move to same directory)
        await storage.move(fs_info.vpath.abs_vfspath, dest_vpath.abs_vfspath)

        # Return FSItem
        fs_item = FSItem(
            vfs_abs_path=dest_vpath.abs_vfspath,
            is_dir=False,
            display_name=new_name,
        )
        return ApiSuccessResponse(data=fs_item)

    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Rename permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Rename error: {e}")
        return ApiFailResponse(message=f"Failed to rename: {str(e)}")


async def copy(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSItem]:
    """Copy file or folder.

    Query parameter:
    - dest_path: Destination path (relative to entity root)

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with source path

    Returns:
        ApiResponse with FSItem for copied item
    """
    if not request_info.is_post:
        return ApiFailResponse(message="Copy action requires POST method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Copy action requires typeid")

    dest_path = request_info.request.query_params.get("dest_path")
    if not dest_path:
        return ApiFailResponse(message="'dest_path' query parameter required")

    try:
        storage = await _get_storage_for_entity(request_info)

        # Check source exists
        if not await storage.exists(fs_info.vpath.abs_vfspath):
            return ApiFailResponse(message="Source not found", status_code=404)

        # Build destination VFSPath
        dest_vpath = VFSPath.from_entity_path(fs_info.vpath.typeid, dest_path.lstrip("/"))

        # Copy
        await storage.copy(fs_info.vpath.abs_vfspath, dest_vpath.abs_vfspath)

        # Return FSItem
        fs_item = FSItem(
            vfs_abs_path=dest_vpath.abs_vfspath,
            is_dir=False,
            display_name=dest_vpath.filename,
        )
        return ApiSuccessResponse(data=fs_item)

    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Copy permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Copy error: {e}")
        return ApiFailResponse(message=f"Failed to copy: {str(e)}")


async def move(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSItem]:
    """Move file or folder.

    Query parameter:
    - dest_path: Destination path (relative to entity root)

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with source path

    Returns:
        ApiResponse with FSItem for moved item
    """
    if not request_info.is_post:
        return ApiFailResponse(message="Move action requires POST method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Move action requires typeid")

    dest_path = request_info.request.query_params.get("dest_path")
    if not dest_path:
        return ApiFailResponse(message="'dest_path' query parameter required")

    try:
        storage = await _get_storage_for_entity(request_info)

        # Check source exists
        if not await storage.exists(fs_info.vpath.abs_vfspath):
            return ApiFailResponse(message="Source not found", status_code=404)

        # Build destination VFSPath
        dest_vpath = VFSPath.from_entity_path(fs_info.vpath.typeid, dest_path.lstrip("/"))

        # Move
        await storage.move(fs_info.vpath.abs_vfspath, dest_vpath.abs_vfspath)

        # Return FSItem
        fs_item = FSItem(
            vfs_abs_path=dest_vpath.abs_vfspath,
            is_dir=False,
            display_name=dest_vpath.filename,
        )
        return ApiSuccessResponse(data=fs_item)

    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Move permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Move error: {e}")
        return ApiFailResponse(message=f"Failed to move: {str(e)}")


# Placeholder implementations for advanced features (not in MVP)
async def create_symlink(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[dict]:
    """Create symbolic link (not implemented in this version)"""
    return ApiFailResponse(message="Symlink support not available in this version")


async def resolve_symlink(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[dict]:
    """Resolve symbolic link (not implemented in this version)"""
    return ApiFailResponse(message="Symlink support not available in this version")


async def download_zip(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[dict]:
    """Download directory as zip (not implemented in this version)"""
    return ApiFailResponse(message="Zip download not available in this version")


async def upload_zip(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[dict]:
    """Upload zip file (not implemented in this version)"""
    return ApiFailResponse(message="Zip upload not available in this version")
