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
from pathlib import Path
from typing import AsyncIterator, List

from starlette.datastructures import UploadFile
from starlette.responses import Response, StreamingResponse

from flow_sdk.api.fs.fs_api import EntityFSReqInfo, VFSPath
from flow_sdk.builtin.faas.serve_static import AppNotBuilt, serve_app_bytes
from flow_sdk.config import default_service_config
from flow_sdk.models import FSEntry
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


async def browse(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[List[FSEntry]]:
    """List directory contents.

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with action and path

    Returns:
        ApiResponse with list of FSEntry objects

    Raises:
        FileNotFoundError: If directory doesn't exist
    """
    if request_info.method != "get":
        return ApiFailResponse(message="Browse action requires GET method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Browse action requires typeid")

    try:
        storage = await _get_storage_for_entity(request_info)
        items = await storage.list_dir(fs_info.vpath.abs_vfspath)
        _stamp_local_paths(items, storage, fs_info.vpath.abs_vfspath)
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


def _stamp_local_paths(items, storage, root: str) -> None:
    """Fill each item's transient ``local_path`` when its bytes are on disk.

    Only the server can resolve an entity's storage root (embedded storage sits
    under a temp dir), so the client must not derive it — deriving it is what
    produced ``/task_inst.md`` at the filesystem root. Same contract as
    ``FlowMessage.Attachment.local_path``: present ⇒ downloaded and openable.
    """
    from pathlib import Path

    root = (root or "").strip("/")
    for item in items or []:
        if getattr(item, "is_dir", False):
            continue
        rel = str(getattr(item, "vfs_abs_path", "") or "").strip("/")
        if root and rel.startswith(root + "/"):
            rel = rel[len(root) + 1 :]
        try:
            p = Path(storage.get_storage_path(rel))
            if p.is_file():
                item.local_path = str(p)
        except Exception as e:  # noqa: BLE001
            logger.debug(f"local_path resolution skipped for {rel}: {e}")


async def push_entity_files_to_hub(entity) -> int:
    """Upload an entity's EXISTING VFS files to its freshly created hub twin.

    The write counterpart of ``fetch_remote_entity_file`` below, and the reason
    it can't simply ride the share request: ``Entity.share()`` POSTs the entity
    as JSON, which carries every FIELD but no bytes — and ``fs/upload`` needs
    the id that POST just minted. So files already in storage need this one
    pass. Live uploads afterwards are handled per-request by
    ``_hub_reflect._reflect_fs_to_hub``; that only fires once the entity is
    ALREADY remote, which is exactly the window this closes.

    A type opts into the record-aware transport by naming its canonical Hub
    file in ``TypeInfo.hub_main_file``; ``TypeInfo.main_layout`` then says how:

    * ``file`` publishes the record's main ref under its canonical Hub name;
    * ``folder`` recursively publishes the record's asset folder, preserving
      relative paths.

    Other entity types keep the generic embedded-VFS fallback used before this
    record-aware transport existed. Best-effort: a hub failure must never fail
    the share.
    """
    if not getattr(entity, "id", None) or not getattr(entity, "remote", False):
        return 0

    try:
        from pathlib import Path

        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
        from flow_sdk.utils.hub import hub_upload_entity_file

        et = BuiltinEntityType(entity.get_type())
    except Exception as e:  # noqa: BLE001
        logger.debug(f"share: unsupported file push for {entity.typeid}: {e}")
        return 0

    # Layout is TypeInfo's — ``hub_main_file`` is the opt-in, ``main_layout`` the how.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    _info = SchemaRegistry.get(entity.get_type())
    canonical_main = _info.hub_main_file if _info is not None else None
    if canonical_main:
        layout = _info.main_layout
        try:
            record = await entity.get_record()
        except Exception as e:  # noqa: BLE001
            logger.debug(f"share: record unavailable for {entity.typeid}: {e}")
            return 0
        if record is None:
            return 0

        if layout == "file":
            main_ref = record.main_ref
            source = Path(main_ref.path) if main_ref is not None else None
            if source is None or not source.is_file() or not canonical_main:
                return 0
            try:
                await hub_upload_entity_file(et, entity.id, canonical_main, source.read_bytes())
            except Exception as e:  # noqa: BLE001
                logger.warning(f"share: file push failed for {entity.typeid}/{canonical_main}: {e}")
                return 0
            return 1

        asset_ref = record.asset_ref
        root = Path(asset_ref.path) if asset_ref is not None else None
        if root is None or not root.is_dir():
            return 0

        pushed = 0
        for source in sorted(root.rglob("*")):
            # Never follow a sender-local symlink outside the declared asset.
            if source.is_symlink() or not source.is_file():
                continue
            rel = source.relative_to(root)
            parent = rel.parent.as_posix()
            sub_path = "upload" if parent == "." else f"upload/{parent}"
            try:
                await hub_upload_entity_file(
                    et,
                    entity.id,
                    rel.name,
                    source.read_bytes(),
                    sub_path=sub_path,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning(f"share: file push failed for {entity.typeid}/{rel.as_posix()}: {e}")
                continue
            pushed += 1
        return pushed

    try:
        storage = get_entity_storage(entity.typeid)
        root = VFSPath.from_entity_path(entity.typeid, "").abs_vfspath.strip("/")
        items = await storage.list_dir(root)
    except Exception as e:  # noqa: BLE001
        logger.debug(f"share: no files to push for {entity.typeid}: {e}")
        return 0

    pushed = 0
    for item in items or []:
        name = getattr(item, "display_name", None)
        if getattr(item, "is_dir", False) or not name:
            continue
        try:
            # ``get_storage_path`` prepends the entity's own folder, so it wants
            # the ENTITY-RELATIVE path — ``vfs_abs_path`` already carries the
            # ``<type>-<id>/`` prefix and would nest it twice.
            rel = item.vfs_abs_path.strip("/")
            if root and rel.startswith(root + "/"):
                rel = rel[len(root) + 1 :]
            content = Path(storage.get_storage_path(rel)).read_bytes()
            await hub_upload_entity_file(et, entity.id, name, content)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"share: file push failed for {entity.typeid}/{name}: {e}")
            continue
        pushed += 1
    return pushed


async def fetch_remote_entity_file(typeid, vfs_path: str, storage: "LocalStorageDriver") -> bool:
    """Pull a missing VFS file from the hub for ANY hub-mirrored (``remote``) entity.

    The read side of the write-through cache: the hub holds the authoritative
    copy of a shared entity's files, and this machine's storage is a cache that
    fills on first miss. Caching locally (rather than streaming straight
    through) is required — the headless agent reads attachments by LOCAL PATH,
    so the bytes must exist on disk, not merely in the response.

    Was FlowMessage-only, which made it dead code: the only thing ever uploaded
    for a message is the packed ``body.flowmsg`` bundle, never the individual
    files this asks for. It becomes live now that ``_hub_reflect`` mirrors real
    per-file uploads to the hub.

    Best-effort: any failure returns False so the caller 404s exactly as before.
    """
    if typeid is None or not getattr(typeid, "id", None) or not getattr(typeid, "type", None):
        return False
    try:
        from pathlib import Path

        from flow_sdk.builtin.flow_message import BODY_FILENAME
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        from flow_sdk.utils.hub import hub_base_url, hub_get
    except Exception:
        return False
    if not hub_base_url():
        return False
    try:
        # A type the hub doesn't host has no endpoint to fall back to.
        et = BuiltinEntityType(str(typeid.type))
        # A message keeps exactly ONE object on the hub: the packed ``body.flowmsg``
        # bundle. Its attachments (``data/<name>``, ``prompt/<name>``) only ever come
        # into being locally, when that bundle is unpacked — they are never uploaded
        # per-file, so asking the hub for one cannot succeed. Without this the miss
        # that precedes an unpack turns into a guaranteed hub 404, which the error
        # reporter escalates into a "Cloud Request Failed" warning at the user while
        # the UI is already showing the correct Download affordance.
        if et is BuiltinEntityType.FLOW_MESSAGE and vfs_path != BODY_FILENAME:
            return False
        entity_cls = SchemaRegistry.get_entity_cls(str(typeid.type))
        entity = await entity_cls.get_one({"id": str(typeid.id)}) if entity_cls else None
    except Exception as e:  # noqa: BLE001
        logger.debug(f"hub fallback: cannot resolve {typeid}: {e}")
        return False
    if entity is None or not getattr(entity, "remote", False):
        return False
    bytes_ = await hub_get(et, str(typeid.id), "fs", f"download/{vfs_path}", raw=True)
    if not bytes_:
        return False
    target = Path(storage.get_storage_path(vfs_path))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(bytes_)
    return True


async def serve(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> Response | ApiFailResponse:
    """Serve a file for the browser to RENDER, at a url that mirrors its path.

    The sibling of ``download``, and the difference is the whole point. Download
    answers "give me these bytes" with ``Content-Disposition: attachment``; this
    answers "show me this page", which needs three things download cannot give:
    an inline disposition, an html-aware read, and — above all — **a url**.

    A page handed to an iframe as ``srcDoc`` has no url of its own, so the
    browser resolves its relative links and assets against the PARENT document:
    ``<a href="page2.html">`` in a shown site became ``/dock/shell/page2.html``,
    an app route holding no file. Every workaround for that (intercepting
    clicks, inlining assets as data: uris) is a way of compensating for the
    missing address. Serving supplies the address instead, and because this
    url's tail IS the file's path, ``page2.html`` beside ``index.html`` resolves
    to ``…/fs/serve/<dir>/page2.html`` with no ``<base>`` and no rewriting.

    Reach is identical to ``download`` — the same entity storage, the same
    paths — so this exposes no file that was not already readable. What changes
    is only how the browser is told to treat the bytes.

    Delegates to ``serve_app_bytes`` rather than restating it: the utf-8 read is
    a documented contract (a locale-default read serves mojibake off a Windows
    host), and so are the etag and the streaming asset branch. Two flags depart
    from the app defaults — no index fallback (a missing file must read as
    missing, not as some other page) and no caching (a file being iterated on is
    not a release).
    """
    if request_info.method != "get":
        return ApiFailResponse(message="Serve action requires GET method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Serve action requires typeid")
    if request_info.request is None:
        return ApiFailResponse(message="Serve action requires an HTTP request")

    try:
        storage = await _get_storage_for_entity(request_info)
        if not await storage.exists(fs_info.vpath.abs_vfspath):
            return ApiFailResponse(message="File not found", status_code=404)

        target = Path(storage.get_storage_path(fs_info.vpath.abs_vfspath))
        return await serve_app_bytes(
            target.parent,
            target.name,
            request_info.request,
            # The url already mirrors the filesystem, so relative refs resolve
            # correctly on their own; a <base> built from a url ending in a
            # FILENAME would append "/" and turn that file into a directory.
            inject_base=False,
            api_url_scheme=default_service_config.service_urls_config.api_url_scheme,
            fallback_index=False,
            cache_control="no-store",
        )
    except AppNotBuilt:
        return ApiFailResponse(message="File not found", status_code=404)
    except FileNotFoundError:
        return ApiFailResponse(message="File not found", status_code=404)
    except Exception as e:
        if _is_permission_denied_error(e):
            logger.warning(f"Serve permission denied: {e}")
            return _permission_denied_response(fs_info.vpath.entity_sub_path)
        logger.error(f"Serve error: {e}")
        return ApiFailResponse(message=f"Failed to serve file: {str(e)}")


async def download(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> StreamingResponse | ApiFailResponse:
    """Download file.

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with file path

    Returns:
        StreamingResponse with file contents or error response
    """
    if request_info.method != "get":
        return ApiFailResponse(message="Download action requires GET method")
    if not fs_info.vpath.typeid:
        return ApiFailResponse(message="Download action requires typeid")

    try:
        storage = await _get_storage_for_entity(request_info)

        # Check if file exists. For hub-mirrored FlowMessages the bytes live
        # on the hub, not the local FS — fall back to a hub fetch and cache
        # locally so future hits + the headless agent (which reads via the
        # local path) both find the file.
        # Cache miss on a shared entity: the hub holds the authoritative copy,
        # so fill the local cache from it and stream. Gated on the entity's
        # ``remote`` flag rather than its type — a task's attachment and a
        # flow_message's file are the same problem.
        if not await storage.exists(fs_info.vpath.abs_vfspath):
            if not await fetch_remote_entity_file(
                fs_info.vpath.typeid,
                fs_info.vpath.entity_sub_path,
                storage,
            ):
                return ApiFailResponse(message="File not found", status_code=404)

        # Stream file
        stream: AsyncIterator[bytes] = storage.stream(fs_info.vpath.abs_vfspath)
        filename = fs_info.vpath.filename
        media_type = _get_media_type(filename)
        # Use inline disposition for media so browsers can render them in
        # <img>/<video>/<audio> tags instead of forcing a download. PDFs are an
        # explicit literal MIME (not an X/ family) so they render inline in the
        # native <iframe>/<embed> PDF viewer rather than triggering a download.
        is_inline = media_type.startswith(("image/", "video/", "audio/")) or media_type == "application/pdf"
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


async def upload(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[List[FSEntry]]:
    """Upload files.

    Args:
        request_info: Current request info with uploaded files
        fs_info: Filesystem request info with destination path

    Returns:
        ApiResponse with list of uploaded FSEntry objects
    """
    if request_info.method != "post":
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

        try:
            for file in files:
                if not file.filename:
                    return ApiFailResponse(message="Upload error: No filename")

                # Build destination path
                dest_path = fs_info.vpath.abs_vfspath.rstrip("/") + "/" + file.filename

                # Read file content
                content = await file.read()

                # Upload file
                await storage.upload(BytesIO(content), dest_path)

                # Create FSEntry for response
                fs_item = FSEntry(
                    vfs_abs_path=dest_path,
                    is_dir=False,
                    size=len(content),
                    display_name=file.filename,
                )
                uploaded_items.append(fs_item)
                logger.debug(f"Uploaded file {file.filename} to {dest_path}")
        finally:
            for file in files:
                try:
                    await file.close()
                except Exception as close_error:
                    logger.debug(f"Failed to close uploaded file {file.filename}: {close_error}")

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
    if request_info.method != "delete":
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


async def mkdir(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSEntry]:
    """Create directory.

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with directory path

    Returns:
        ApiResponse with FSEntry for new directory
    """
    if request_info.method != "post":
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

        # Return FSEntry
        fs_item = FSEntry(
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


async def write(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSEntry]:
    """Write content to file.

    Args:
        request_info: Current request info with file content in body
        fs_info: Filesystem request info with file path

    Returns:
        ApiResponse with FSEntry for written file
    """
    if request_info.method != "post":
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

        # Auto-version asset files: bump frontmatter `version` + file-scoped git
        # commit when an asset's content actually changed. Best-effort, local-only,
        # and gated to frontmatter-bearing files — never blocks the save.
        from flow_sdk.actions.fs.asset_versioning import _real_path, autoversion_commit_local  # noqa: PLC0415

        # Both post-write hooks want the on-disk path; resolve it once. None ⇒
        # remote/sandbox storage — no local git tree, and the box's own indexer
        # owns the entity row.
        real_path = _real_path(storage, fs_info.vpath.abs_vfspath)
        await autoversion_commit_local(
            storage, fs_info.vpath.abs_vfspath, content if isinstance(content, str) else "", real_path=real_path
        )

        # The file IS the record for a file-backed entity (agent.md, SKILL.md,
        # a task's folder…), so a write here must land in the row too — else
        # every reader of the entity (an Agent's `system_prompt` at launch, the
        # card, search) keeps the pre-edit values until some sweep happens to
        # walk this path. One-path resync through the same seam the indexer and
        # the SubAgent writer use; a non-asset path is a cheap no-op there.
        await _resync_entity_from_disk(real_path)

        # Return FSEntry
        fs_item = FSEntry(
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


async def _resync_entity_from_disk(real_path: str | None) -> None:
    """Re-extract whatever entity the just-written local file backs. Best-effort.

    Awaited (not scheduled) on purpose: the editor that wrote refetches the
    entity right after the save resolves, and read-after-write is the whole
    point. ``mint=False``: resync an EXISTING entity only — minting here would
    stamp an identity capsule into the bytes the client just wrote.
    """
    if not real_path:
        return
    try:
        from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415

        await reindex_paths([real_path], mint=False)
    except Exception as e:  # noqa: BLE001 — a resync failure must never fail the save
        logger.warning("[fs-write] entity resync skipped (non-fatal): %s", e)


async def rename(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSEntry]:
    """Rename file or folder.

    Query parameter:
    - new_name: New name (without path separators)

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with path

    Returns:
        ApiResponse with FSEntry for renamed item
    """
    if request_info.method != "post":
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

        # Return FSEntry
        fs_item = FSEntry(
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


async def copy(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSEntry]:
    """Copy file or folder.

    Query parameter:
    - dest_path: Destination path (relative to entity root)

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with source path

    Returns:
        ApiResponse with FSEntry for copied item
    """
    if request_info.method != "post":
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

        # Return FSEntry
        fs_item = FSEntry(
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


async def move(request_info: RequestInfo, fs_info: EntityFSReqInfo) -> ApiResponse[FSEntry]:
    """Move file or folder.

    Query parameter:
    - dest_path: Destination path (relative to entity root)

    Args:
        request_info: Current request info
        fs_info: Filesystem request info with source path

    Returns:
        ApiResponse with FSEntry for moved item
    """
    if request_info.method != "post":
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

        # Return FSEntry
        fs_item = FSEntry(
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
