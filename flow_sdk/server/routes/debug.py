"""Debug/introspection routes for runtime server state.

Local-only surface (no auth), same trust model as /api/hooks/report.
Intended for development, manual QA, and integration-test assertions.
"""

import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .websocket import get_active_connection, get_connection_infos

router = APIRouter()


@router.get("/api/v1/debug/connections")
async def debug_connections():
    """Return the current WebSocket connections with presence state.

    Response shape::

        {
          "connections": [
            {"id": "<uuid>", "visible": true, "focused": true, "last_presence_at_ms_ago": 42},
            ...
          ],
          "active_id": "<uuid-of-active-tab-or-null>",
          "count": 2
        }

    ``last_presence_at_ms_ago`` is computed against ``time.monotonic()``, matching
    the clock used to stamp ``ConnectionInfo.last_presence_at``.
    """
    infos = get_connection_infos()
    now = time.monotonic()

    connections = [
        {
            "id": cid,
            "visible": info.visible,
            "focused": info.focused,
            "last_presence_at_ms_ago": int((now - info.last_presence_at) * 1000),
        }
        for cid, info in infos.items()
    ]

    active = get_active_connection()
    active_id = active[0] if active else None

    return JSONResponse(
        content={
            "connections": connections,
            "active_id": active_id,
            "count": len(connections),
        }
    )
