"""Markdown sync HTTP action — a thin wrapper over ``flow_sdk/core/md_sync``.

Addressed as ``/api/v1/graph/compute_node/@local/md_sync/...``:

  GET    /md_sync/status?project_id=   → MdSyncStatusSpec
  POST   /md_sync/sync                 → body {project_id} → MdSyncStatusSpec (with ``written``)
  POST   /md_sync/source/add           → body {project_id, name} → MdSyncStatusSpec

A missing or old ``syncmd`` is a ``state`` of the answer, not a failure.
"""
from __future__ import annotations

from flow_sdk.core import action
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


async def _root(project_id: str | None) -> str | None:
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    project = await Project.get_by_id(str(project_id)) if project_id else None
    return project.fs_storage_mount_path if project else None


@action.all(action_name="md_sync", methods=["get", "post"], types="all")
async def md_sync_action() -> ApiResponse:
    from flow_sdk.core import md_sync  # noqa: PLC0415

    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")

    method = request_info.request.method.upper()
    sub_path = (request_info.sub_path or "").strip("/")
    if method == "GET" and sub_path == "status":
        result = await md_sync.status(await _root(request_info.request.query_params.get("project_id")))
    elif method == "POST" and sub_path in ("sync", "source/add"):
        payload = await request_info.get_post_data() or {}
        root = await _root(payload.get("project_id"))
        if sub_path == "sync":
            result = await md_sync.sync(root)
        else:
            result = await md_sync.add_source(root, str(payload.get("name") or ""))
    else:
        return ApiFailResponse(message=f"Unknown {method} md_sync/{sub_path}")
    return ApiSuccessResponse(data=result.model_dump(mode="json"))
