"""Project routes that are not CRUD.

* ``GET  /project/resolve/{code}`` — public code→project lookup for the join flow.
* ``POST /project/home-page`` ``{project_id}`` — the asset the project's home
  page names, resolved and scoped (``Project.open_home_page``). One call the
  loaders make before render, mirroring ``/api/v1/agents/auto-launch``, so landing on it is a load-time
  REDIRECT rather than a post-render hijack.

Standard CRUD on Project is served by the generic graph router; the
collaboration overlay actions (join, heartbeat, ensure-collaboration-code) are
registered as instance actions on the Project entity itself.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/project/home-page")
async def open_home_page(request: Request):
    """Resolve the project's declared home page to its asset (or the empty payload)."""
    try:
        body = await request.json()
    except Exception:
        body = {}
    project_id = str((body or {}).get("project_id") or "").strip()
    if not project_id:
        return ApiFailResponse(message="project_id is required", status_code=400)
    project = await Project.get_by_id(project_id)
    if project is None:
        return ApiFailResponse(message=f"Unknown project: {project_id}", status_code=404)
    try:
        return ApiSuccessResponse(data=await project.open_home_page())
    except Exception as exc:  # noqa: BLE001 — the loader must get a stable answer, never a 500 page
        logger.warning("project home page failed for %s: %s", project_id, exc)
        # A success envelope carrying `error`, for the reason agents.py gives:
        # the TS client unwraps a fail envelope to `undefined`, which reads as
        # "no home page" and hides that something broke.
        return ApiSuccessResponse(data={"asset": None, "type": None, "error": str(exc)})


@router.get("/project/resolve/{code}")
async def resolve_project_by_code(code: str) -> dict:
    """Resolve a project's shareable session_code to the project."""
    proj = await Project.get_by_session_code(code)
    if proj is None:
        raise HTTPException(status_code=404, detail="Session code not found")
    return {
        "project_id": proj.id,
        "session_code": proj.session_code,
        "name": proj.name,
        "host_name": None,
        "members_count": len(proj.presence or []),
    }
