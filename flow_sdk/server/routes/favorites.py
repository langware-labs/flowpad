"""POST /api/v1/favorites/summary — batch tooltip summary for favorited entities.

Each favorite tile on the desktop grid shows a hover tooltip with the entity's
live name + a per-type subtitle (e.g. last prompt for an AgenticProcess). The
frontend POSTs all favorited refs in one shot; the server dispatches to each
entity's ``tooltip_summary()``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.responses.response import ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# Per-entry subtitle cap. Tooltip line-clamps to 3 lines anyway; truncating
# server-side keeps response payloads bounded even if last_prompt grows large.
SUBTITLE_MAX_CHARS = 240

# Hard upper bound on a single batch. Above this we reject — favorites in
# practice number in the tens; 200 is generous and prevents DoS.
MAX_REFS_PER_REQUEST = 200


class FavoriteRef(BaseModel):
    type: str
    id: str


class FavoriteSummary(BaseModel):
    type: str
    id: str
    name: Optional[str] = None
    subtitle: Optional[str] = None


class SummaryRequest(BaseModel):
    refs: list[FavoriteRef] = Field(default_factory=list, max_length=MAX_REFS_PER_REQUEST)


class SummaryResponse(BaseModel):
    summaries: list[FavoriteSummary]


def _truncate(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    return value if len(value) <= SUBTITLE_MAX_CHARS else value[:SUBTITLE_MAX_CHARS] + "…"


async def _summarize(ref: FavoriteRef) -> FavoriteSummary:
    entity_cls = Entity.get_entity_model_by_type(ref.type)
    if entity_cls is None:
        return FavoriteSummary(type=ref.type, id=ref.id)
    # Some favorites are stored with a TypeId-form id ("<type>-<uuid>") rather
    # than a bare uuid. get_by_id expects the bare id, so strip a redundant
    # leading "<type>-" prefix before the lookup.
    bare_id = ref.id
    prefix = f"{ref.type}-"
    if bare_id.startswith(prefix):
        bare_id = bare_id[len(prefix):]
    try:
        entity = await entity_cls.get_by_id(bare_id)
    except Exception:
        logger.exception("favorites/summary get_by_id failed for %s-%s", ref.type, ref.id)
        return FavoriteSummary(type=ref.type, id=ref.id)
    if entity is None:
        return FavoriteSummary(type=ref.type, id=ref.id)
    try:
        summary = entity.tooltip_summary()
    except Exception:
        logger.exception("favorites/summary tooltip_summary failed for %s-%s", ref.type, ref.id)
        return FavoriteSummary(type=ref.type, id=ref.id, name=entity.name)
    name = summary.get("name")
    subtitle = summary.get("subtitle")
    return FavoriteSummary(
        type=ref.type,
        id=ref.id,
        name=name if isinstance(name, str) else None,
        subtitle=_truncate(subtitle) if isinstance(subtitle, str) else None,
    )


@router.post("/api/v1/favorites/summary", response_model=ApiSuccessResponse[SummaryResponse])
async def favorites_summary(req: SummaryRequest) -> ApiSuccessResponse[SummaryResponse]:
    """Standard ``{status, data}`` envelope; ``data`` is a :class:`SummaryResponse`."""
    if not req.refs:
        return ApiSuccessResponse(data=SummaryResponse(summaries=[]))
    summaries = await asyncio.gather(*(_summarize(ref) for ref in req.refs))
    return ApiSuccessResponse(data=SummaryResponse(summaries=list(summaries)))
