"""Toplog routes — single owner under ``/api/v1/toplog/*``.

* ``GET  /state``   — current ``{enabled, filter}``.
* ``POST /on``      — turn tags on. Body: ``{"tags": ["pty", ...]}``.
* ``POST /off``     — turn tags off. Body: ``{"tags": ["pty", ...]}``.
* ``POST /enable``  — flip the master switch on.
* ``POST /disable`` — flip the master switch off.
* ``POST /persist`` — keep (or stop keeping) the state across a backend restart.
  Body: ``{"persist": true}``. Off by default: a restart resets tracing.
* ``POST /client-log`` — the frontend's toplog lines, batched, written into this
  instance's log under the ``toplog.client`` logger so front and back share one
  timestamped trail. Body: ``{"lines": [{"tags": [...], "msg": "...", "ts": ms}]}``.

These exist for the frontend, which can't write the filesystem. Each mutator
writes the authoritative ``toplog.json``; the FSOp watcher trigger
(``builtin_toplog_filter_apply``) then broadcasts the new state to every open
client. The route also returns the new state so the calling client updates
immediately. See ``flow_sdk/toplog.py``.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from flow_sdk import toplog
from flow_sdk.responses.response import ApiSuccessResponse

router = APIRouter(prefix="/api/v1/toplog")

_client_logger = logging.getLogger("toplog.client")

# One flush from the frontend is ≤1s of lines; anything beyond this is a runaway
# caller, and the log is not the place to absorb it.
_MAX_CLIENT_LINES = 500
_MAX_CLIENT_MSG_CHARS = 4000


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


async def _tags(request: Request) -> list[str]:
    return toplog._normalize((await _body(request)).get("tags") or [])


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


@router.post("/persist")
async def set_persist(request: Request):
    """Keep the state across a backend restart. Body: ``{"persist": bool}``
    (defaults to true)."""
    toplog.persist(bool((await _body(request)).get("persist", True)))
    return ApiSuccessResponse(data=toplog.state())


@router.post("/client-log")
async def client_log(request: Request):
    """Write the frontend's batched toplog lines into this instance's log.

    Only lines whose tags are active HERE are written — the backend file is the
    authority, so a client with a stale mirror can't log a tag that was turned
    off. Returns how many lines were written."""
    lines = (await _body(request)).get("lines") or []
    written = 0
    if isinstance(lines, list) and toplog.is_enabled():
        on = toplog.active_tags()
        for line in lines[:_MAX_CLIENT_LINES]:
            if not isinstance(line, dict):
                continue
            active = [t for t in toplog._normalize(line.get("tags") or []) if t in on]
            if not active:
                continue
            msg = str(line.get("msg", ""))[:_MAX_CLIENT_MSG_CHARS]
            _client_logger.info("[%s] %s (client_ts=%s)", ",".join(active), msg, line.get("ts"))
            written += 1
        dropped = len(lines) - _MAX_CLIENT_LINES
        if dropped > 0:
            _client_logger.warning("client-log batch over cap: %d lines dropped", dropped)
    return ApiSuccessResponse(data={"written": written})
