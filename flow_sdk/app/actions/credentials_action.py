"""Credentials HTTP action — a thin wrapper over ``builtin/credential_service``.

Addressed as ``/api/v1/graph/compute_node/@local/credentials/...``:

  GET    /credentials/status?project_id=   → CredentialsStatusSpec (names only)
  POST   /credentials/save                 → body {scope, project_id?, typeid?, manifest, values?} → summary
  POST   /credentials/values               → body {typeid, values} → summary
  POST   /credentials/delete               → body {typeid} → {deleted, kept}

A refusal carries ``data.error_code`` when the condition is fixable (a
committable ``.env.local``, a disabled vault). A value is never returned.
"""
from __future__ import annotations

import logging

from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _summary(spec) -> dict:
    """What a caller needs after a write: which credential, and where it lives."""
    return {
        "typeid": str(spec.typeid),
        "name": str(spec.name or ""),
        "title": spec.title or str(spec.name or ""),
        "scope": spec.scope,
        "project_id": spec.project_id,
    }


@action.all(action_name="credentials", methods=["get", "post"], types="all")
async def credentials_action() -> ApiResponse:
    from flow_sdk.builtin.credential_service import (  # noqa: PLC0415
        CredentialError,
        delete_credential,
        get_project,
        save_credential,
        set_credential_values,
    )

    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")

    method = request_info.request.method.upper()
    sub_path = (request_info.sub_path or "").strip("/")
    try:
        if method == "GET" and sub_path == "status":
            from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415

            project_id = request_info.request.query_params.get("project_id")
            project = await get_project(project_id)
            if project_id and project is None:
                return ApiFailResponse(message="project not found")
            return ApiSuccessResponse(data=(await credentials_status(project)).model_dump(mode="json"))
        if method == "POST":
            payload = await request_info.get_post_data() or {}
            if sub_path == "save":
                spec = await save_credential(
                    manifest=payload.get("manifest") or {},
                    scope=payload.get("scope"),
                    project_id=payload.get("project_id"),
                    typeid=payload.get("typeid"),
                    values=payload.get("values") or {},
                )
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "values":
                spec = await set_credential_values(payload.get("typeid") or "", payload.get("values") or {})
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "delete":
                return ApiSuccessResponse(data=await delete_credential(payload.get("typeid") or ""))
        return ApiFailResponse(message=f"Unknown {method} credentials/{sub_path}")
    except CredentialError as e:
        return ApiFailResponse(message=str(e), data={"error_code": e.code} if e.code else None)
    except Exception as e:
        logger.error("credentials action error [%s %s]: %s", method, sub_path, e)
        return ApiFailResponse(message=str(e))
