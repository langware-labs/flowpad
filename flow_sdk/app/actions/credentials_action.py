"""Credentials HTTP action — a thin wrapper over ``builtin/credential_service``.

Addressed as ``/api/v1/graph/compute_node/@local/credentials/...``:

  GET    /credentials/status?project_id=   → CredentialsStatusSpec (names only)
  POST   /credentials/save                 → body {scope, project_id?, typeid?, manifest, values?} → summary
  POST   /credentials/values               → body {typeid, values} → summary
  POST   /credentials/set                  → body {name, project_id?, values} → summary (declares from its template)
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
        declare_credential,
        delete_credential,
        get_project,
        save_credential,
        set_credential_by_name,
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

            params = request_info.request.query_params
            project_id = params.get("project_id")
            project = await get_project(project_id)
            if project_id and project is None:
                return ApiFailResponse(message="project not found")
            try:
                status = await credentials_status(project, params.get("deployment_id") or "")
            except ValueError as e:
                return ApiFailResponse(message=str(e))
            return ApiSuccessResponse(data=status.model_dump(mode="json"))
        if method == "POST":
            payload = await request_info.get_post_data() or {}
            if sub_path == "save":
                manifest = dict(payload.get("manifest") or {})
                # An older client still says where values live in the manifest: that is the
                # deployment's now, so it becomes the store choice. Per-environment overrides
                # have no meaning here any more (the boot lift moved existing ones).
                legacy_store = manifest.pop("value_store", None)
                manifest.pop("environments", None)
                spec = await save_credential(
                    manifest=manifest,
                    scope=payload.get("scope"),
                    project_id=payload.get("project_id"),
                    typeid=payload.get("typeid"),
                    values=payload.get("values") or {},
                    deployment_id=payload.get("deployment_id"),
                    store=payload.get("store") or legacy_store,
                )
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "values":
                spec = await set_credential_values(
                    payload.get("typeid") or "", payload.get("values") or {}, payload.get("deployment_id")
                )
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "set":
                spec = await set_credential_by_name(
                    payload.get("name") or "", payload.get("values") or {},
                    project_id=payload.get("project_id"), deployment_id=payload.get("deployment_id"),
                )
                return ApiSuccessResponse(data=_summary(spec))
            if sub_path == "declare":
                spec = await declare_credential(payload.get("manifest") or {}, project_id=payload.get("project_id") or "")
                return ApiSuccessResponse(data=_summary(spec))
            # On a deployment's machine: the hub places the deployment's values (``credential_service``).
            if sub_path == "drop":
                from flow_sdk.builtin.credential_service import drop_folder  # noqa: PLC0415

                return ApiSuccessResponse(data={"dir": str(drop_folder())})
            if sub_path == "place":
                from flow_sdk.builtin.credential_service import place_values  # noqa: PLC0415

                return ApiSuccessResponse(data=await place_values(
                    payload.get("deployment_id") or "", payload.get("project_id") or "", payload.get("file") or "",
                    payload.get("environment") or "",
                ))
            if sub_path == "unplace":
                from flow_sdk.builtin.credential_service import unplace_values  # noqa: PLC0415

                return ApiSuccessResponse(data=await unplace_values(
                    payload.get("deployment_id") or "", payload.get("project_id") or "", list(payload.get("names") or []),
                    payload.get("environment") or "",
                ))
            if sub_path == "teardown":
                # The deployment's machine is about to go: its sources undo what they set up at providers.
                from flow_sdk.builtin.credential_service import teardown_sources  # noqa: PLC0415

                return ApiSuccessResponse(data={"sources": await teardown_sources()})
            if sub_path == "use-mine":
                from flow_sdk.builtin.credential_service import use_mine  # noqa: PLC0415

                names = payload.get("names")
                return ApiSuccessResponse(data=await use_mine(payload.get("deployment_id") or "", list(names) if names else None))
            if sub_path == "audit":
                from flow_sdk.builtin.credential_sweep import sweep_local  # noqa: PLC0415

                result = await sweep_local(
                    project_id=payload.get("project_id") or "",
                    names=payload.get("names") or [],
                    roots=payload.get("roots") or [],
                )
                return ApiSuccessResponse(data=result.model_dump(mode="json"))
            if sub_path == "delete":
                return ApiSuccessResponse(data=(await delete_credential(payload.get("typeid") or "")).model_dump(mode="json"))
        return ApiFailResponse(message=f"Unknown {method} credentials/{sub_path}")
    except CredentialError as e:
        # A refusal is the caller's to fix — never a server error.
        return ApiFailResponse(
            message=str(e),
            data={"error_code": e.code} if e.code else None,
            status_code=409 if e.code == "exists" else 400,
        )
    except Exception as e:
        logger.error("credentials action error [%s %s]: %s", method, sub_path, e)
        return ApiFailResponse(message=str(e))
