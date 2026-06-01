"""App-secrets HTTP action — thin wrapper over flow_sdk.cli.auth.secrets.

Endpoints:
  GET    /secrets/is-enabled  → {enabled: bool}
  POST   /secrets/enable      → {enabled: bool}
  GET    /secrets             → [{name, description, created_at}]
  POST   /secrets             → body {name, value, description?}
  DELETE /secrets/{name}      → {ok: True}

Reading a secret value is intentionally not exposed: the UI must never see
plaintext values. SDK consumers use ``read_secret`` in-process.
"""

import json
import logging

from flow_sdk.cli.auth.secrets import (
    delete_secret,
    enable_secrets,
    get_secrets,
    is_secrets_enabled,
    write_secret,
)
from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


_IS_ENABLED = "is-enabled"
_ENABLE = "enable"


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
