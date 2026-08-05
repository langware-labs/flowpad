"""`POST /api/v1/assets/share` — share one asset, get back a reviewer's link.

The HTTP face of :mod:`flow_sdk.assets.share_orchestrator`. It lives on the
server rather than in the CLI for the same two reasons ``routes/display.py``
does: the server owns where the hub is (and which of its two URLs is the
browser one), and it owns the entity graph the gates read.

Every refusal comes back as HTTP 200 with an ``error_code`` — see
``routes/display.py`` for why (``ApiFailResponse.status_code`` is a body field,
so branching on the transport status collapses every failure into one).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter()


class AssetShareRequest(BaseModel):
    """One address, plus the extra repo paths that belong in the same commit."""

    typeid: Optional[str] = None
    path: Optional[str] = None
    #: Repo paths to commit alongside the asset — e.g. the test file a
    #: breadcrumb capsule was inserted into. Always explicit, never inferred.
    with_paths: list[str] = []
    message: Optional[str] = None
    link_project: bool = False
    dry_run: bool = False
    no_commit: bool = False


@router.post("/api/v1/assets/share")
async def share_asset(req: AssetShareRequest):
    from flow_sdk.assets.share_orchestrator import ShareBlocked, share_asset_to_hub
    from flow_sdk.request_context.methods import get_current_request_info

    typeid = (req.typeid or "").strip() or None
    path = (req.path or "").strip() or None
    if not typeid and not path:
        return ApiFailResponse(message="Must include one of: typeid, path", data={"error_code": "INVALID_ARG"})

    request_info = get_current_request_info()
    try:
        outcome = await share_asset_to_hub(
            typeid=typeid,
            path=path,
            with_paths=[p for p in req.with_paths if str(p).strip()],
            message=req.message,
            link_project=req.link_project,
            dry_run=req.dry_run,
            no_commit=req.no_commit,
            actor=getattr(request_info, "someone_typeid", None),
        )
    except ShareBlocked as blocked:
        return ApiFailResponse(
            message=blocked.message,
            data={
                "error_code": blocked.code,
                "remediation": blocked.remediation,
                **(blocked.data or {}),
            },
        )
    return ApiSuccessResponse(data=outcome.payload())
