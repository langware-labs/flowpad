"""The first-run gate over HTTP: may a project be set up here yet?

``GET /api/v1/first-run/state`` answers ``{"state": "open" | "closed"}``, and answers only once the shipped
wizard can be looked up (``core/wizard/first_run``): on a fresh database that is when the system-content index
ends, some 40 seconds after the app is serving. The request is held until then -- event-driven, no polling --
because the app decides at load what to show first (the wizard, an invitation's dialog), and a state read
before the wizard exists would call the gate open for good.
"""

from __future__ import annotations

from fastapi import APIRouter

from flow_sdk.core.wizard.first_run import first_run_state
from flow_sdk.responses import ApiResponse

router = APIRouter()


@router.get("/api/v1/first-run/state")
async def get_first_run_state():
    return ApiResponse.success({"state": await first_run_state()})
