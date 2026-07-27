"""Generic entity-subgraph route — layer 2 of the graph stack.

``GET /api/v1/subgraph/{projection}`` serves any registered projection
(``flow_sdk.subgraph.register_projection``) as a lenient GraphPayload the
frontend's ``graphFromPayload`` renders directly. Query params pass through to
the builder as strings; each builder documents and parses its own.

The route names no projection: ``flow_sdk/subgraph/builtins.py`` owns that
list, so adding one never edits this file.

Layer 1 (the Sigma engine) and the existing worldview/dep_graph routes are
untouched — this is the reusable seam future features register into.
"""
from __future__ import annotations

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter()


@router.get("/api/v1/subgraph/{projection}")
async def get_subgraph(projection: str, request: Request):
    from flow_sdk.subgraph import (  # noqa: PLC0415
        get_projection,
        known_projections,
        register_builtin_projections,
    )

    register_builtin_projections()
    builder = get_projection(projection)
    if builder is None:
        return ApiFailResponse(
            message=f"unknown subgraph projection {projection!r}",
            data={"known": known_projections()},
        )
    try:
        return ApiSuccessResponse(data=await builder(dict(request.query_params)))
    except (TypeError, ValueError) as exc:
        # Builder param validation (e.g. a malformed tag name) is a client
        # error, not a server fault.
        return ApiFailResponse(message=f"invalid subgraph params: {exc}")
