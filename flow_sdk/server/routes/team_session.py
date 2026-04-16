"""Team session resolution route.

Exposes code→session lookup for the join flow. Standard CRUD (create, get,
patch) is served by the generic graph router, and join/heartbeat/end are
registered as instance actions on the TeamSession entity.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from flow_sdk.builtin.team_session import TeamSession

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/team_session/resolve/{code}")
async def resolve_team_session(code: str) -> dict:
    """Resolve a session code to its TeamSession + bound AgenticProcess id."""
    ts = await TeamSession.get_by_code(code)
    if ts is None:
        raise HTTPException(status_code=404, detail="Session code not found or session ended")
    return {
        "team_session_id": ts.id,
        "agentic_process_id": ts.agentic_process_id,
        "session_code": ts.session_code,
        "host_name": ts.host_name,
        "members_count": len(ts.members or []),
    }
