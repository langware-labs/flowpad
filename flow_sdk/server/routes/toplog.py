"""Toplog routes — single owner under ``/api/v1/toplog/*``.

* ``GET  /state``   — current ``{enabled, filter}``.
* ``POST /on``      — turn topics on. Body: ``{"topics": ["pty", ...]}``.
* ``POST /off``     — turn topics off. Body: ``{"topics": ["pty", ...]}``.
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


async def _topics(request: Request) -> list[str]:
    try:
        body = await request.json()
    except Exception:
        body = {}
    topics = (body or {}).get("topics") or []
    if isinstance(topics, str):
        topics = [topics]
    return [str(t) for t in topics]


@router.get("/state")
async def get_state():
    """Return the current toplog state for this instance."""
    return ApiSuccessResponse(data=toplog.state())


@router.post("/on")
async def turn_on(request: Request):
    """Turn the given topics on. Body: ``{"topics": [...]}``."""
    toplog.on(*await _topics(request))
    return ApiSuccessResponse(data=toplog.state())


@router.post("/off")
async def turn_off(request: Request):
    """Turn the given topics off. Body: ``{"topics": [...]}``."""
    toplog.off(*await _topics(request))
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
