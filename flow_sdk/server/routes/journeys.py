"""Journey routes — thin wrappers over the `Journey` entity interface.

Every route returns the **JourneyJournal**: the journal IS the progress object
(cursor / status / steps_left / entries), so there is no separate progress DTO
and no `/plan` endpoint. The step DESCRIPTORS come from the journey folder's
``graph.json``, read by the client through the standard asset channel.

* ``GET  /{id}/progress``  — active journal, else the most recent, else null.
* ``GET  /{id}/history``   — every journal for the caller, newest-first.
* ``POST /{id}/launch``    — idempotent; active journal or a fresh one.
* ``POST /{id}/restart``   — archive the active journal, start a fresh one.
* ``POST /{id}/advance``   ``{node_id, event?}`` — record a step, move the cursor.
* ``POST /resume``         ``{journal_id}`` — re-activate a past journal.

All logic lives on the entity (`flow_sdk/builtin/journey.py`) — these are transport.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/journeys")


async def _acting_user_id() -> str:
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    user = await get_or_create_local_user()
    return user.id


async def _journey(journey_id: str):
    from flow_sdk.builtin.journey import Journey

    return await Journey.get_by_id(journey_id)


def _dump(journal: Any) -> Optional[dict]:
    return journal.model_dump(mode="json") if journal is not None else None


@router.get("/auto-launch")
async def auto_launch(project_id: str = ""):
    """The journey to enter on project load (`{"journey_id": … | null}`).

    One cheap call the home loader makes before render, so entering a journey is
    a load-time REDIRECT to `?journeyId=` rather than a post-render hijack."""
    from flow_sdk.builtin.journey import Journey

    journal = await Journey.auto_launch_for(
        await _acting_user_id(),
        project_id=project_id.strip() or None,
    )
    return ApiSuccessResponse(data={"journey_id": journal.journey_id if journal else None})


@router.post("/resume")
async def resume(request: Request):
    """Re-activate a past journal (archives whichever one is active now)."""
    from flow_sdk.builtin.journey import Journey

    try:
        body = await request.json()
    except Exception:
        body = {}
    journal_id = str((body or {}).get("journal_id") or "")
    if not journal_id:
        return ApiFailResponse(message="journal_id is required")
    journal = await Journey.resume(journal_id, await _acting_user_id())
    if journal is None:
        return ApiFailResponse(message=f"Unknown journal: {journal_id}")
    return ApiSuccessResponse(data=_dump(journal))


@router.get("/{journey_id}/progress")
async def progress(journey_id: str):
    journey = await _journey(journey_id)
    if journey is None:
        return ApiFailResponse(message=f"Unknown journey: {journey_id}")
    return ApiSuccessResponse(data=_dump(await journey.progress(await _acting_user_id())))


@router.get("/{journey_id}/history")
async def history(journey_id: str):
    journey = await _journey(journey_id)
    if journey is None:
        return ApiFailResponse(message=f"Unknown journey: {journey_id}")
    rows = await journey.history(await _acting_user_id())
    return ApiSuccessResponse(data=[_dump(j) for j in rows])


@router.post("/{journey_id}/launch")
async def launch(journey_id: str):
    journey = await _journey(journey_id)
    if journey is None:
        return ApiFailResponse(message=f"Unknown journey: {journey_id}")
    journal = await journey.launch(await _acting_user_id())
    if journal is None:
        if not await journey.gate_open():
            return ApiFailResponse(message="Nothing to set up — this journey's capabilities are already available.")
        return ApiFailResponse(message="journey has no guided_step nodes")
    return ApiSuccessResponse(data=_dump(journal))


@router.post("/{journey_id}/restart")
async def restart(journey_id: str):
    journey = await _journey(journey_id)
    if journey is None:
        return ApiFailResponse(message=f"Unknown journey: {journey_id}")
    journal = await journey.restart(await _acting_user_id())
    if journal is None:
        if not await journey.gate_open():
            return ApiFailResponse(message="Nothing to set up — this journey's capabilities are already available.")
        return ApiFailResponse(message="journey has no guided_step nodes")
    return ApiSuccessResponse(data=_dump(journal))


@router.post("/{journey_id}/advance")
async def advance(journey_id: str, request: Request):
    journey = await _journey(journey_id)
    if journey is None:
        return ApiFailResponse(message=f"Unknown journey: {journey_id}")
    try:
        body = await request.json()
    except Exception:
        body = {}
    node_id = str((body or {}).get("node_id") or "")
    event = str((body or {}).get("event") or "done")
    if not node_id:
        return ApiFailResponse(message="node_id is required")
    if event not in ("done", "skipped"):
        return ApiFailResponse(message="event must be 'done' or 'skipped'")
    journal = await journey.advance(await _acting_user_id(), node_id, event)
    return ApiSuccessResponse(data=_dump(journal))
