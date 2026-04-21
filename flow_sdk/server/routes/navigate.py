"""Agent-driven navigation routes.

Exposes endpoints that let a local agent (invoked via the `flow navigate ...`
CLI) steer the UI in the user's browser tab.

The server picks the single "active" browser tab via
``get_active_connection()`` (see ``websocket.py``) and sends a targeted
``ui_command`` WS message. The UI listener reads the entity's dockPointer
and performs the actual in-app navigation.
"""

import json
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.type_id import TypeId

from .websocket import get_active_connection, send_personal_message

router = APIRouter()


class NavigateEntityRequest(BaseModel):
    """Body for POST /api/v1/agent/navigate/entity.

    ``typeid`` is the canonical string form, e.g. ``"shell-<uuid>"`` or
    ``"project-@local"``. The single-arg CLI and the internal ``TypeId`` class
    agree on this format.
    """

    typeid: str


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    """Return a predictable error body the CLI can map to an exit code."""
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error_code": code, "error": message},
    )


async def _lookup_entity(type_name: str, entity_id: str) -> Optional[Entity]:
    """Fetch an entity by (type, id) without going through auth-scoped routes.

    Returns ``None`` if the type is unknown or the id doesn't exist under
    that type — both collapse to "entity not found" at the CLI.
    """
    entity_cls = Entity.get_entity_model_by_type(type_name)
    if entity_cls is None:
        return None
    try:
        return await entity_cls.get_by_id(entity_id)
    except Exception:
        return None


@router.post("/api/v1/agent/navigate/entity")
async def navigate_entity(req: NavigateEntityRequest):
    """Navigate the active browser tab to an entity's dockPointer.

    Errors are all shaped as ``{ok:false, error_code, error}`` so the CLI
    can map them directly to exit codes.
    """
    # Parse the TypeId string. Invalid format → 400.
    try:
        typeid = TypeId(req.typeid)
    except (ValueError, IndexError) as e:
        return _error(400, "INVALID_TYPEID", f"Invalid typeid '{req.typeid}': {e}")

    if typeid.id is None:
        return _error(400, "INVALID_TYPEID", f"Missing id in typeid '{req.typeid}'")

    # Validate entity existence BEFORE touching the UI so the agent gets a
    # clean error rather than a silent no-op.
    entity = await _lookup_entity(typeid.type, typeid.id)
    if entity is None:
        return _error(
            404,
            "ENTITY_NOT_FOUND",
            f"Entity not found: {typeid.type}-{typeid.id}",
        )

    # Pick the active tab. None means zero open tabs.
    active = get_active_connection()
    if active is None:
        return _error(409, "NO_ACTIVE_TAB", "No active tab")

    connection_id, ws = active

    # Send a targeted UI command. The UI listener resolves the entity on its
    # side (so it benefits from the local cache) and invokes the navigation.
    message = {
        "message_type": "ui_command",
        "message_id": str(uuid4()),
        "kind": "navigate_entity",
        "type": typeid.type,
        "id": typeid.id,
    }
    await send_personal_message(json.dumps(message), ws)

    return {
        "ok": True,
        "connection_id": connection_id,
        "type": typeid.type,
        "id": typeid.id,
    }
