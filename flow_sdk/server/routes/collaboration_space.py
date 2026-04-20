"""Collaboration space resolution route.

Exposes code→space lookup for the join flow. Standard CRUD (create, get,
patch) is served by the generic graph router, and join/heartbeat/end are
registered as instance actions on the CollaborationSpace entity.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from flow_sdk.builtin.collaboration_space import CollaborationSpace

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/collaboration_space/resolve/{code}")
async def resolve_collaboration_space(code: str) -> dict:
    """Resolve a session code to its CollaborationSpace."""
    sp = await CollaborationSpace.get_by_code(code)
    if sp is None:
        raise HTTPException(status_code=404, detail="Session code not found or space ended")
    return {
        "collaboration_space_id": sp.id,
        "session_code": sp.session_code,
        "host_name": sp.host_name,
        "project_id": sp.project_id,
        "members_count": len(sp.members or []),
    }
