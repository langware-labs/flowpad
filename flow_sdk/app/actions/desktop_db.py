"""Desktop DB management action — thin HTTP wrappers over flow_sdk.system_tools."""

import logging

from flow_sdk._compat import StrEnum
from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse
from flow_sdk.system_tools import (
    archive,
    backup_db,
    clear_all_data,
    clear_index,
    get_backup_folder,
    get_database_paths,
    get_database_stats,
    get_db_folder,
    get_db_settings,
    get_logs_folder,
    open_folder,
    restore,
    set_db_path,
)

logger = logging.getLogger(__name__)


class DesktopDbSubpath(StrEnum):
    PATHS = "paths"
    STATS = "stats"
    CLEAR = "clear"
    BACKUP = "backup"
    ARCHIVE = "archive"
    RESTORE = "restore"
    CLEAR_INDEX = "clear-index"
    OPEN_BACKUP = "open-backup"
    OPEN_DB = "open-db"
    OPEN_LOGS = "open-logs"
    DB_SETTINGS = "db-settings"



@action.all(action_name="desktop-db", methods=["get", "post", "delete"], types="all")
async def desktop_db_action() -> ApiResponse:
    """Desktop DB management action.

    GET  /desktop-db/paths        → database + folder paths
    GET  /desktop-db/stats        → DB size, row counts, entity type breakdown
    GET  /desktop-db/db-settings  → current DB path
    POST /desktop-db/clear        → backup + wipe DB + clear index + reinit
    POST /desktop-db/backup       → backup DB
    POST /desktop-db/archive      → full archive (DB + records snapshot)
    POST /desktop-db/restore      → restore DB from backup path in body
    POST /desktop-db/clear-index  → clear FTS index only
    POST /desktop-db/open-backup  → open backup folder in OS
    POST /desktop-db/open-db      → open DB folder in OS
    POST /desktop-db/open-logs    → open logs folder in OS
    POST /desktop-db/db-settings  → switch active DB path
    """
    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")

    method = request_info.request.method.upper()
    sub_path = request_info.sub_path or ""

    try:
        # --- GET ---
        if method == "GET":
            if sub_path in (DesktopDbSubpath.PATHS, ""):
                return ApiSuccessResponse(data=get_database_paths())
            if sub_path == DesktopDbSubpath.STATS:
                return ApiSuccessResponse(data=await get_database_stats())
            if sub_path == DesktopDbSubpath.DB_SETTINGS:
                return ApiSuccessResponse(data=get_db_settings())
            return ApiFailResponse(message=f"Unknown GET subpath: {sub_path}")

        # --- POST ---
        if method == "POST":
            if sub_path == DesktopDbSubpath.CLEAR:
                return ApiSuccessResponse(data=await clear_all_data())
            if sub_path == DesktopDbSubpath.BACKUP:
                return ApiSuccessResponse(data=await backup_db())
            if sub_path == DesktopDbSubpath.ARCHIVE:
                return ApiSuccessResponse(data=await archive())
            if sub_path == DesktopDbSubpath.RESTORE:
                import json
                body = await request_info.request.body()
                payload = json.loads(body)
                backup_path = payload.get("backup_path", "").strip()
                if not backup_path:
                    return ApiFailResponse(message="backup_path is required")
                return ApiSuccessResponse(data=await restore(backup_path))
            if sub_path == DesktopDbSubpath.CLEAR_INDEX:
                import json
                body = await request_info.request.body()
                payload = json.loads(body) if body else {}
                types = payload.get("types") or None  # optional list[str]
                return ApiSuccessResponse(data=await clear_index(types))
            if sub_path == DesktopDbSubpath.OPEN_BACKUP:
                open_folder(get_backup_folder())
                return ApiSuccessResponse(data={"message": "Opened backup folder"})
            if sub_path == DesktopDbSubpath.OPEN_DB:
                open_folder(get_db_folder())
                return ApiSuccessResponse(data={"message": "Opened DB folder"})
            if sub_path == DesktopDbSubpath.OPEN_LOGS:
                open_folder(get_logs_folder())
                return ApiSuccessResponse(data={"message": "Opened logs folder"})
            if sub_path == DesktopDbSubpath.DB_SETTINGS:
                import json
                body = await request_info.request.body()
                payload = json.loads(body)
                db_path = payload.get("db_path", "").strip()
                if not db_path:
                    return ApiFailResponse(message="db_path is required")
                return ApiSuccessResponse(data=await set_db_path(db_path))
            return ApiFailResponse(message=f"Unknown POST subpath: {sub_path}")

        return ApiFailResponse(message=f"Method {method} not supported")

    except FileNotFoundError as e:
        return ApiFailResponse(message=str(e))
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    except Exception as e:
        logger.error(f"desktop-db error [{sub_path}]: {e}")
        return ApiFailResponse(message=str(e))
