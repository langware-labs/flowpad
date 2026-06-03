"""App-secrets HTTP action — thin wrapper over flow_sdk.cli.auth.secrets.

Endpoints:
  GET    /secrets/is-enabled         → {enabled: bool}
  POST   /secrets/enable             → {enabled: bool}
  POST   /secrets/seed-key           → body {key} → {enabled: bool} (Electron-only)
  POST   /secrets/migrate-to-flow-rs → {key: str|None, has_legacy: bool} (Electron-only)
  POST   /secrets/cleanup-legacy     → {ok: bool} (Electron-only; after migration)
  GET    /secrets                    → [{name, description, created_at}]
  POST   /secrets                    → body {name, value, description?}
  DELETE /secrets/{name}             → {ok: True}

Reading a secret value is intentionally not exposed: the UI must never see
plaintext values. SDK consumers use ``read_secret`` in-process. The
``migrate-to-flow-rs`` endpoint is the ONE exception — it returns the
sod-key value so a signed Electron launcher can re-write it through the
bundled flow-rs binary, replacing the legacy python3.x-owned ACL trust
list with flow-rs. Available only to localhost callers.
"""

import json
import logging

from flow_sdk.cli.auth.secrets import (
    cleanup_legacy_sod_key,
    delete_secret,
    enable_secrets,
    get_secrets,
    is_secrets_enabled,
    read_legacy_sod_key,
    seed_sod_key,
    write_secret,
)
from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


_IS_ENABLED = "is-enabled"
_ENABLE = "enable"
_SEED_KEY = "seed-key"
_MIGRATE_TO_FLOW_RS = "migrate-to-flow-rs"
_CLEANUP_LEGACY = "cleanup-legacy"


@action.all(action_name="secrets", methods=["get", "post", "delete"], types="all")
async def secrets_action() -> ApiResponse:
    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")

    method = request_info.request.method.upper()
    sub_path = (request_info.sub_path or "").strip("/")

    try:
        if method == "GET":
            if sub_path == _IS_ENABLED:
                return ApiSuccessResponse(data={"enabled": is_secrets_enabled()})
            if sub_path == "":
                return ApiSuccessResponse(data=get_secrets())
            return ApiFailResponse(message=f"Unknown GET subpath: {sub_path}")

        if method == "POST":
            if sub_path == _ENABLE:
                return ApiSuccessResponse(data={"enabled": enable_secrets()})
            if sub_path == _SEED_KEY:
                body = await request_info.request.body()
                payload = json.loads(body) if body else {}
                key = (payload.get("key") or "").strip()
                if not key:
                    return ApiFailResponse(message="key is required")
                return ApiSuccessResponse(data={"enabled": seed_sod_key(key)})
            if sub_path == _MIGRATE_TO_FLOW_RS:
                key = read_legacy_sod_key()
                return ApiSuccessResponse(data={"key": key, "has_legacy": key is not None})
            if sub_path == _CLEANUP_LEGACY:
                return ApiSuccessResponse(data={"ok": cleanup_legacy_sod_key()})
            if sub_path == "":
                body = await request_info.request.body()
                payload = json.loads(body) if body else {}
                name = (payload.get("name") or "").strip()
                value = payload.get("value")
                description = payload.get("description") or ""
                if not name:
                    return ApiFailResponse(message="name is required")
                if value is None:
                    return ApiFailResponse(message="value is required")
                write_secret(name, value, description)
                return ApiSuccessResponse(data={"ok": True})
            return ApiFailResponse(message=f"Unknown POST subpath: {sub_path}")

        if method == "DELETE":
            if not sub_path:
                return ApiFailResponse(message="secret name is required in path")
            await delete_secret(sub_path)
            return ApiSuccessResponse(data={"ok": True})

        return ApiFailResponse(message=f"Method {method} not supported")

    except Exception as e:
        logger.error(f"secrets action error [{method} {sub_path}]: {e}")
        return ApiFailResponse(message=str(e))
