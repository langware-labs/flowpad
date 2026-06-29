"""Wiki resolve-by-name API: GET /api/v1/wiki/resolve?name=<n>&prefer_type=<t>.

Returns ``{ type, id, asset_ref } | null``. Returns JSON ``null`` (HTTP 200)
on miss — frontend treats that as the "Create it" trigger, so a 404 would
be a regression.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from flow_sdk.wiki.resolver import _pick_candidate
from flow_sdk.wiki.store import get_async_default_store


logger = logging.getLogger(__name__)

router = APIRouter()


async def _entity_asset_ref(type_: str, id_: str) -> str:
    """Read ``asset_ref`` from the entities table for ``(type, id)``.

    Returns an empty string when the row has no asset_ref (e.g. records
    that don't map to an on-disk file). One indexed lookup + a JSON
    extract; no new schema.
    """
    from sqlalchemy import select as sa_select

    from flow_sdk.db import session as _session
    from flow_sdk.db.drivers.sqlite.connection import EntitySchema

    async with _session() as s:
        row = await s.execute(
            sa_select(EntitySchema.data).where(
                EntitySchema.type == type_,
                EntitySchema.id == id_,
            )
        )
        record = row.first()
    if record is None:
        return ""
    raw = record[0]
    if not raw:
        return ""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, json.JSONDecodeError):
        return ""
    if not isinstance(data, dict):
        return ""
    val = data.get("asset_ref")
    if isinstance(val, str):
        return val
    if isinstance(val, dict):
        # Persisted FSRef shape ({"path": ..., "ref_type": ...}).
        path = val.get("path")
        return str(path) if path else ""
    return ""


@router.get("/api/v1/wiki/resolve")
async def resolve_wiki_link(
    name: str = Query(..., description="The wikilink target name (e.g. 'foo' from `[[foo]]`)."),
    prefer_type: Optional[str] = Query(
        None,
        description="When multiple candidates match, prefer this record type.",
    ),
    space: str = Query(
        "@local",
        description="The space the name resolves within (default '@local' = the local instance).",
    ),
):
    """Resolve a wikilink target by name within a space.

    ``space`` is the org/scope separator from the ``wiki/<space>/<name>`` URL.
    Only ``@local`` (the local store) is supported today; the parameter is
    accepted so the URL contract is stable for future remote/workspace spaces.
    """
    if space and space != "@local":
        logger.warning("[wiki/resolve] non-local space %r not yet supported; resolving locally", space)
    candidates = await get_async_default_store().find_entities_by_uname_or_name(name)
    if not candidates:
        return JSONResponse(content=None)

    type_, id_ = _pick_candidate(candidates, prefer_type)
    asset_ref = await _entity_asset_ref(type_, id_)
    return JSONResponse(content={"type": type_, "id": id_, "asset_ref": asset_ref})
