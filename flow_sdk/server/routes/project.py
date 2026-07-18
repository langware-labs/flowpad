"""Project collaboration-code resolution route.

Exposes a public code→project lookup for the join flow. Standard CRUD on Project
is served by the generic graph router; the collaboration overlay actions
(join, heartbeat, ensure-collaboration-code) are registered as instance actions
on the Project entity itself.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)
router = APIRouter()


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
