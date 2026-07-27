"""Toplog routes — single owner under ``/api/v1/toplog/*``.

* ``GET  /state``   — current ``{enabled, filter}``.
* ``POST /on``      — turn tags on. Body: ``{"tags": ["pty", ...]}``.
* ``POST /off``     — turn tags off. Body: ``{"tags": ["pty", ...]}``.
* ``POST /enable``  — flip the master switch on.
* ``POST /disable`` — flip the master switch off.

These exist for the frontend, which can't write the filesystem. Each mutator
writes the authoritative ``toplog.json``; the FSOp watcher trigger
(``builtin_toplog_filter_apply``) then broadcasts the new state to every open
client. The route also returns the new state so the calling client updates
immediately. See ``flow_sdk/toplog.py``.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from flow_sdk import toplog
from flow_sdk.responses.response import ApiSuccessResponse

router = APIRouter(prefix="/api/v1/toplog")


async def _tags(request: Request) -> list[str]:
    try:
        body = await request.json()
    except Exception:
        body = {}
    tags = (body or {}).get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    return [str(t) for t in tags]


@router.get("/state")
async def get_state():
    """Return the current toplog state for this instance."""
    return ApiSuccessResponse(data=toplog.state())


@router.post("/on")
async def turn_on(request: Request):
    """Turn the given tags on. Body: ``{"tags": [...]}``."""
    toplog.on(*await _tags(request))
    return ApiSuccessResponse(data=toplog.state())


@router.post("/off")
async def turn_off(request: Request):
    """Turn the given tags off. Body: ``{"tags": [...]}``."""
    toplog.off(*await _tags(request))
    return ApiSuccessResponse(data=toplog.state())


@router.post("/enable")
async def enable():
    """Flip the master switch on."""
    toplog.enable()
    return ApiSuccessResponse(data=toplog.state())


@router.post("/disable")
async def disable():
    """Flip the master switch off."""
    toplog.disable()
    return ApiSuccessResponse(data=toplog.state())
