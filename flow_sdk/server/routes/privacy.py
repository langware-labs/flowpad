"""Data-privacy mode routes — single owner under ``/api/v1/privacy/*``.

* ``GET  /mode``  — current mode ("local" | "connected")
* ``POST /mode``  — set the mode; persists per-instance and broadcasts to all
                    open clients so they update live.

The mode is a hard, server-enforced privacy guarantee — see
``flow_sdk/instance_settings/privacy_mode.py`` and the gates that call
``is_local_mode()`` (hub transport, cloud-auth routes, hub reflection, share).
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from flow_sdk.instance_settings.privacy_mode import apply_privacy_mode, get_privacy_mode
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter(prefix="/api/v1/privacy")


@router.get("/mode")
async def get_mode():
    """Return the current data-privacy mode for this instance."""
    return ApiSuccessResponse(data={"privacy_mode": get_privacy_mode()})


@router.post("/mode")
async def set_mode(request: Request):
    """Set the data-privacy mode. Body: ``{"privacy_mode": "local" | "connected"}``."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    mode = (body or {}).get("privacy_mode")
    try:
        stored = await apply_privacy_mode(mode)
    except ValueError as e:
        return JSONResponse(
            content=ApiFailResponse(message=str(e)).model_dump(mode="json"),
            status_code=400,
        )
    return ApiSuccessResponse(data={"privacy_mode": stored})
