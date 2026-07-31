"""The ingestor's write side.

``ingest_items`` mints the deterministic v5 id, gates on the content digest,
preserves local state across re-delivery, and emits the ``ingest.*`` family.
Until now its only caller was ``sync_source`` ← the heartbeat poller, so the
only way to produce a ``SourceItem`` was to wait for a timer — and anything
else that wanted to record one (an agent, a test, a CLI) had to go around the
chokepoint and lose every one of those guarantees.

This route does not add a second chokepoint. It exposes the existing one, so
``flow record create source_item`` converges with what the poller writes
instead of racing it.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/ingest")

#: One request may not exceed the per-item storm cap in INCREMENTAL mode; past
#: it, `IngestMode.for_run` selects BACKFILL and the batch reports once instead
#: of per item. Callers are not asked to know that — they post a batch and the
#: mode decision stays where it already lives.
MAX_ITEMS_PER_REQUEST = 500


def _to_item(raw: dict[str, Any]):
    from flow_sdk.ingest.models import IngestItem  # noqa: PLC0415

    missing = [k for k in ("source_id", "provider", "kind", "stream_key", "external_id")
               if not str(raw.get(k) or "").strip()]
    if missing:
        raise ValueError(f"missing required field(s): {', '.join(missing)}")
    allowed = {f for f in IngestItem.__dataclass_fields__}
    unknown = set(raw) - allowed
    if unknown:
        # Refuse rather than drop: a caller that misspelled `title` as `subject`
        # would otherwise get a row with an empty name and no way to notice.
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    return IngestItem(**{k: v for k, v in raw.items() if k in allowed})


@router.post("/items")
async def ingest_items_route(request: Request):
    """Ingest a batch through the same path the poller uses.

    Body: ``{"items": [ {<IngestItem>}, … ], "first_run"?: bool}``.
    ``first_run`` lets a caller that knows it is backfilling say so; otherwise
    the batch size decides, exactly as it does for a driver.
    """
    from flow_sdk.ingest.ingestor import ingest_items  # noqa: PLC0415
    from flow_sdk.ingest.models import IngestMode  # noqa: PLC0415

    try:
        body = await request.json()
    except Exception:
        return ApiFailResponse(message="Expected a JSON object body")
    if not isinstance(body, dict):
        return ApiFailResponse(message="Expected a JSON object body")

    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return ApiFailResponse(message="items must be a non-empty array")
    if len(raw_items) > MAX_ITEMS_PER_REQUEST:
        return ApiFailResponse(
            message=f"{len(raw_items)} items exceeds the {MAX_ITEMS_PER_REQUEST} per-request limit"
        )

    try:
        items = [_to_item(r) for r in raw_items]
    except (TypeError, ValueError) as exc:
        return ApiFailResponse(message=str(exc))

    mode = IngestMode.for_run(
        first_run=bool(body.get("first_run")), item_count=len(items)
    )
    try:
        report = await ingest_items(items, mode=mode)
    except Exception as exc:  # noqa: BLE001 — a bad payload must not 500 the server
        logger.exception("ingest: batch failed")
        return ApiFailResponse(message=f"ingest failed: {exc}")

    return ApiSuccessResponse(data={
        **report.as_counts(),
        "mode": mode.value,
        "changed_ids": report.changed_ids,
        "outcomes": [
            {"entity_id": o.entity_id, "external_id": o.external_id, "status": o.status}
            for o in report.outcomes
        ],
    })
