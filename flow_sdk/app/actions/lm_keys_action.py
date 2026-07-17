"""LM-provider API-key HTTP action — thin wrapper over
``flow_sdk.cli.auth.lm_api_keys``.

Endpoints:
  GET    /lm_keys            → [{provider, configured, created_at}]
  POST   /lm_keys            → body {provider, key} → {ok: True, valid, message} (auto-validated)
  POST   /lm_keys/test       → body {provider}      → {valid, message}
  DELETE /lm_keys/{provider} → {ok: True}

Reading a key value is intentionally not exposed: the UI must never see plaintext
keys. In-process callers (workers) read via ``get_lm_api`` in the SDK.
"""

import json
import logging

from flow_sdk.cli.auth.lm_api_keys import delete_lm_api, list_lm_api, set_lm_api, validate_lm_api
from flow_sdk.core import action
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _parse_provider(raw: str) -> LMApiProvider | None:
    try:
        return LMApiProvider(raw)
    except ValueError:
        return None


@action.all(action_name="lm_keys", methods=["get", "post", "delete"], types="all")
async def lm_keys_action() -> ApiResponse:
    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")

    method = request_info.request.method.upper()
    sub_path = (request_info.sub_path or "").strip("/")

    try:
        if method == "GET":
            if sub_path == "":
                return ApiSuccessResponse(data=list_lm_api())
            return ApiFailResponse(message=f"Unknown GET subpath: {sub_path}")

        if method == "POST":
            body = await request_info.request.body()
            payload = json.loads(body) if body else {}
            raw = (payload.get("provider") or "").strip()
            if not raw:
                return ApiFailResponse(message="provider is required")
            provider = _parse_provider(raw)
            if provider is None:
                return ApiFailResponse(message=f"Unknown provider: {raw}")

            if sub_path == "test":
                return ApiSuccessResponse(data=await validate_lm_api(provider))
            if sub_path == "":
                key = payload.get("key")
                if not key:
                    return ApiFailResponse(message="key is required")
                set_lm_api(key, provider)
                # Auto-validate on set so the UI can confirm the key immediately.
                result = await validate_lm_api(provider)
                return ApiSuccessResponse(data={"ok": True, **result})
            return ApiFailResponse(message=f"Unknown POST subpath: {sub_path}")

        if method == "DELETE":
            if not sub_path:
                return ApiFailResponse(message="provider is required in path")
            provider = _parse_provider(sub_path)
            if provider is None:
                return ApiFailResponse(message=f"Unknown provider: {sub_path}")
            await delete_lm_api(provider)
            return ApiSuccessResponse(data={"ok": True})

        return ApiFailResponse(message=f"Method {method} not supported")

    except Exception as e:
        logger.error(f"lm_keys action error [{method} {sub_path}]: {e}")
        return ApiFailResponse(message=str(e))
