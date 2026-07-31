"""Debug/introspection routes for runtime server state.

Local-only surface (no auth), same trust model as /api/hooks/report.
Intended for development, manual QA, and integration-test assertions.
"""

import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

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


@router.get("/api/v1/debug/trigger_callbacks")
async def debug_trigger_callbacks():
    """List registered Python callbacks usable as `ActionType.CALLBACK` targets.

    The triggers UI reads this to surface a human-readable `meaning` for the
    callback wired into a FSOp trigger (e.g. `builtin_transcript_streamer_route`).

    Standard ``ApiResponse`` envelope (consumed via the SDK ``apiClient``,
    which unwraps ``data``)::

        { "status": "SUCCESS", "data": {
            "callbacks": [
              {"name": "<registered name>", "meaning": "<docstring-ish>", "is_async": true},
              ...
            ],
            "count": <int>
        } }
    """
    from flow_sdk.builtin import trigger_callbacks
    from flow_sdk.responses.response import ApiSuccessResponse

    items = trigger_callbacks.list_registered()
    return ApiSuccessResponse(data={"callbacks": items, "count": len(items)})


@router.post("/api/v1/debug/emit_tag")
async def emit_tag_route(request: Request):
    """Dev/QA: emit a FlowEvent on the backend bus — proves the
    backend→tag_msg→app-bus pipe end-to-end (docs/flow-events.md phase 1).

    Validates the tag against the shared grammar by default; pass
    ``force: true`` to exercise the permissive-bus path with a malformed name
    (the bus itself never gates — this gate is only a typo guard for humans).
    """
    try:
        body = await request.json()
    except Exception:
        body = {}
    tag = str((body or {}).get("tag") or "")
    target = str((body or {}).get("target") or "")
    if not tag or not target:
        return ApiFailResponse(message="tag and target are required")
    if not (body or {}).get("force"):
        from flow_sdk.tags.grammar import is_valid_tag

        if not is_valid_tag(tag):
            return ApiFailResponse(
                message=f"invalid tag {tag!r} (dot-separated lowercase; pass force:true to emit anyway)"
            )
    from flow_sdk.tags import emit_tag

    event = emit_tag(tag, target, (body or {}).get("data") or {})
    return ApiSuccessResponse(data=event.model_dump() if event else None)


@router.get("/api/v1/debug/observed_tags")
async def observed_tags_route():
    """Tags seen on the backend bus since boot (bounded in-memory map) —
    the anonymous half of the taxonomy gardening view. Blessed tags are
    ordinary entities (``GET /api/v1/graph/tag``); the browse surface merges
    the two and dims names that appear here but have no entity row.

    Standard ``ApiResponse`` envelope::

        { "status": "SUCCESS", "data": {
            "observed": {"<tag>": {"count": 3, "first_ts": "...",
                                      "last_ts": "...", "last_target": "..."}},
            "count": <int>
        } }
    """
    from flow_sdk.tags import event_bus

    observed = event_bus.observed_tags()
    return ApiSuccessResponse(data={"observed": observed, "count": len(observed)})


@router.get("/api/v1/debug/recent_events")
async def recent_events_route():
    """The tail of FORWARDED envelopes, so the Signals feed paints on open.

    The bus persists nothing (law 4) and its observation map stores tag NAMES
    only, so without this a freshly-opened feed would sit empty until the next
    event happened to fire. Bounded at ``RECENT_EVENTS_CAP``; scope is exactly
    what the app is already allowed to see (``FORWARDED_TAG_PATTERNS``), so this
    grants no visibility the live stream doesn't.

    Standard ``ApiResponse`` envelope::

        { "status": "SUCCESS", "data": {
            "events": [ {<FlowEvent>}, ... ],   # oldest first
            "count": <int>, "cap": <int>,
            "patterns": ["graph_workflow.*", "ingest.*.sync.*"]
        } }
    """
    from flow_sdk.tags.ws_forward import (
        FORWARDED_TAG_PATTERNS,
        RECENT_EVENTS_CAP,
        recent_events,
    )

    events = recent_events()
    return ApiSuccessResponse(data={
        "events": events,
        "count": len(events),
        "cap": RECENT_EVENTS_CAP,
        "patterns": list(FORWARDED_TAG_PATTERNS),
    })
