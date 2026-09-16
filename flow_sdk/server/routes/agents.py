"""Agent routes — thin wrappers over the `Agent` entity interface.

* ``GET  /auto-launch?project_id=`` — the project's once-only marks.
* ``POST /auto-launch`` ``{project_id}`` — the agent to auto-launch when that
  project is opened, launched, with its prompt queued. Mirrors
  ``/api/v1/journeys/auto-launch``: one call the dock loaders make before
  render, so entering the session is a load-time REDIRECT rather than a
  post-render hijack.

All logic lives on the entity (`flow_sdk/builtin/agent.py`) — this is transport.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/agents")

@router.get("/auto-launch")
async def auto_launch_marks(project_id: str = ""):
    """The project's once-only marks: `{"auto_launched_agent_ids": [...]}`."""
    from flow_sdk.builtin.agent import Agent

    project_id = project_id.strip()
    if not project_id:
        return ApiFailResponse(message="project_id is required", status_code=400)
    return ApiSuccessResponse(data={"auto_launched_agent_ids": Agent.auto_launched_ids(project_id)})


@router.post("/auto-launch")
async def auto_launch(request: Request):
    """Launch the project's auto-launch agent once (`AutoLaunchOutcome.to_payload()` or nulls)."""
    from flow_sdk.builtin.agent import Agent, AutoLaunchOutcome

    try:
        body = await request.json()
    except Exception:
        body = {}
    project_id = str((body or {}).get("project_id") or "").strip()
    if not project_id:
        return ApiFailResponse(message="project_id is required", status_code=400)
    try:
        outcome = await Agent.auto_launch_for(project_id)
    except Exception as exc:  # noqa: BLE001 — the loader must get a stable failure, never a 500 page
        logger.warning("agent auto-launch failed for project %s: %s", project_id, exc)
        return ApiFailResponse(message=f"auto-launch failed: {exc}")
    return ApiSuccessResponse(data=outcome.to_payload() if outcome else AutoLaunchOutcome.none_payload())
