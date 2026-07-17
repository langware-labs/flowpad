"""Flow-graph routes — single owner under ``/api/v1/topics/*``.

* ``POST /emit``    — emit a topic event through FlowManager. Body:
  ``{"topic": "a.b.c", "payload": {...}, "envelope": {correlation_id?, depth?,
  causation?, source?, scope?}}``. The envelope block lets spawned agents
  extend their parent chain (loop budgets are charged per correlation chain).
* ``GET  /graph``   — full wiring snapshot (topics, flow_nodes, flow_graphs,
  listen/emit edges) for the studio canvas.
* ``GET  /journal`` — recent routed events; ``?corr=<id>`` filters one chain,
  ``?limit=N`` caps rows.

See ``flow_sdk/flow_manager/`` for the routing semantics.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from flow_sdk.flow_manager import TopicEvent, get_flow_manager
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter(prefix="/api/v1/topics")


@router.post("/emit")
async def emit(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    topic = (body or {}).get("topic")
    if not topic:
        return ApiFailResponse(message="topic is required")
    payload = body.get("payload") or {}
    if not isinstance(payload, dict):
        return ApiFailResponse(message="payload must be an object")
    envelope = body.get("envelope") or {}

    event_kwargs: dict = {"topic": topic, "payload": payload}
    for field in ("correlation_id", "causation", "depth", "source", "scope"):
        if field in envelope and envelope[field] is not None:
            event_kwargs[field] = envelope[field]
    event_kwargs.setdefault("source", "rest")

    try:
        event = TopicEvent(**event_kwargs)
    except Exception as e:
        return ApiFailResponse(message=f"Invalid envelope: {e}")

    try:
        routed = await get_flow_manager().emit(event)
    except ValueError as e:
        return ApiFailResponse(message=str(e))
    return ApiSuccessResponse(data=routed.model_dump(mode="json"))


@router.get("/graph")
async def graph():
    snapshot = await get_flow_manager().graph_snapshot()
    return ApiSuccessResponse(data=snapshot)


@router.get("/journal")
async def journal(request: Request):
    params = dict(request.query_params)
    limit = int(params.get("limit", 200))
    corr = params.get("corr") or None
    entries = get_flow_manager().journal_tail(limit=limit, correlation_id=corr)
    return ApiSuccessResponse(data=entries)
