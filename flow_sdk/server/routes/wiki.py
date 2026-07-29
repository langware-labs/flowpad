"""Deprecated compatibility adapter for the pre-entity Wiki endpoint."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from flow_sdk.responses.response import ApiSuccessResponse
from flow_sdk.wiki.service import resolve_legacy_unscoped


router = APIRouter()


@router.get("/api/v1/wiki/resolve")
async def resolve_wiki_link(
    name: str = Query(...),
    prefer_type: str | None = Query(None),
    space: str = Query("@local"),
):
    """Delegate old callers to the one compatibility service.

    ``prefer_type`` is accepted but intentionally ignored: ambiguity is now a
    semantic result, not an alphabetical/type-preference winner. New callers
    use ``/api/v1/graph/wiki/<ref>/resolve?word=...``.
    """
    del prefer_type
    if space != "@local":
        raise HTTPException(status_code=400, detail="Legacy Wiki endpoint supports @local only")
    try:
        result = await resolve_legacy_unscoped(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ApiSuccessResponse(data=result)
