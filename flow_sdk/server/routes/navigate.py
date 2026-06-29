"""Agent-driven navigation routes.

Exposes endpoints that let a local agent (invoked via the `flow navigate ...`
CLI) steer the UI in the user's browser tab.

The server picks the single "active" browser tab via
``get_active_connection()`` (see ``websocket.py``) and sends a targeted
``ui_command`` WS message. The UI listener reads the entity's dockPointer
and performs the actual in-app navigation.
"""

import json
import os
from typing import Optional, Union
from uuid import uuid4

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.fs_store.type_id import TypeId, is_named_id

from .websocket import (
    get_active_connection,
    get_active_connection_info,
    get_connection_infos,
    send_personal_message,
)

router = APIRouter()


class NavigateEntityRequest(BaseModel):
    """Body for POST /api/v1/agent/navigate/entity.

    ``typeid`` is the canonical string form, e.g. ``"shell-<uuid>"`` or
    ``"project-@local"``. The single-arg CLI and the internal ``TypeId`` class
    agree on this format.

    ``connection_id`` is the optional WebSocket connection ID of the target browser tab.
    If omitted, navigates the active (most-visible/focused) tab.
    """

    typeid: str
    connection_id: Optional[str] = None


def _error(status_code: int, code: str, message: str) -> JSONResponse:
    """Return a predictable error body the CLI can map to an exit code."""
    return JSONResponse(
        status_code=status_code,
        content={"ok": False, "error_code": code, "error": message},
    )


def _pick_target(connection_id: Optional[str]) -> Union[tuple, JSONResponse]:
    """Resolve the target browser tab for a UI command.

    Explicit ``connection_id`` if supplied (404 if it isn't open), else the
    active (most-visible/focused, recency tiebreak) tab (409 if none open).
    Returns ``(connection_id, ws)`` or a ready-to-return error response.
    Shared by every ``navigate/*`` route so targeting stays identical.
    """
    if connection_id:
        info = get_connection_infos().get(connection_id)
        if info is None:
            return _error(404, "CONNECTION_NOT_FOUND", f"Connection not found: {connection_id}")
        return connection_id, info.ws
    active = get_active_connection()
    if active is None:
        return _error(409, "NO_ACTIVE_TAB", "No active tab")
    return active


async def _send_ui_command(ws, kind: str, **fields) -> None:
    """Send a targeted ``ui_command`` WS frame (adds ``message_type`` + id)."""
    await send_personal_message(
        json.dumps(
            {"message_type": "ui_command", "message_id": str(uuid4()), "kind": kind, **fields}
        ),
        ws,
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
        # Named refs (e.g. "project-@local") resolve by uname, not raw id —
        # `get_by_id` does a literal id lookup and misses the "@name" form.
        if is_named_id(entity_id):
            return await entity_cls.get_by_uname(entity_id[1:])
        return await entity_cls.get_by_id(entity_id)
    except Exception:
        return None


async def _with_project_path(ctx: dict) -> dict:
    """Enrich a browser-context snapshot with the current project's on-disk path.

    The UI mirrors ``CurrentProjectTypeId`` (a ``project-<id>`` string), but an
    agent that materializes a record needs the project's filesystem mount, not
    just its id — otherwise it writes into the worker's cwd (for the global
    Flowpad Assistant that is the system project, not the user's current one).
    Resolve it here so ``flow context list`` also carries ``CurrentProjectPath``
    and the records skill can target the user's current project. Best-effort:
    on any miss the key is simply omitted.
    """
    out = dict(ctx or {})
    proj_tid = out.get("CurrentProjectTypeId")
    if not proj_tid:
        return out
    try:
        tid = TypeId(proj_tid)
        proj = await _lookup_entity(tid.type, tid.id) if tid.id else None
        mount = getattr(proj, "fs_storage_mount_path", None) if proj else None
        if mount:
            out["CurrentProjectPath"] = str(mount)
    except Exception:
        pass
    return out


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

    target = _pick_target(req.connection_id)
    if isinstance(target, JSONResponse):
        return target
    connection_id, ws = target

    # Send a targeted UI command. The UI listener resolves the entity on its
    # side (so it benefits from the local cache) and invokes the navigation.
    await _send_ui_command(ws, "navigate_entity", type=typeid.type, id=typeid.id)

    return {
        "ok": True,
        "connection_id": connection_id,
        "type": typeid.type,
        "id": typeid.id,
    }


class NavigateFileRequest(BaseModel):
    """Body for POST /api/v1/agent/navigate/file.

    ``path`` is a filesystem path (absolute or ``~``-relative). ``connection_id``
    optionally targets a specific browser tab; omitted = the active tab.
    """

    path: str
    connection_id: Optional[str] = None


@router.post("/api/v1/agent/navigate/file")
async def navigate_file(req: NavigateFileRequest):
    """Navigate the active browser tab to a file by path.

    Two-step resolution (the ``flow navigate file`` behaviour):
      1. If the path is already an indexed asset (an entity owns it via
         ``asset_ref``), navigate to that entity's stable view — same
         ``navigate_entity`` command the typeid route uses, so the UI lands on
         the entity's bespoke editor.
      2. Otherwise fall back to a raw VFS open (``navigate_vfs``) — the asset
         editor opens the path directly, no entity / indexer required. This is
         what makes "agent writes hello.md, then opens it" work immediately.
    """
    raw = (req.path or "").strip()
    if not raw:
        return _error(400, "INVALID_PATH", "Missing path")
    path = canonical_posix_path(os.path.abspath(os.path.expanduser(raw)))

    target = _pick_target(req.connection_id)
    if isinstance(target, JSONResponse):
        return target
    connection_id, ws = target

    # Step 1 — prefer the entity-backed asset when the path is already indexed.
    entity = await Entity.get_by_asset_ref(path)
    if entity is not None and getattr(entity, "id", None):
        await _send_ui_command(ws, "navigate_entity", type=entity.get_type(), id=entity.id)
        return {
            "ok": True,
            "connection_id": connection_id,
            "mode": "entity",
            "path": path,
            "type": entity.get_type(),
            "id": entity.id,
        }

    # Step 2 — fall back to a raw VFS open. The client builds the asset-editor
    # dock pointer for the path (editor chosen by extension) and navigates.
    await _send_ui_command(ws, "navigate_vfs", path=path)
    return {"ok": True, "connection_id": connection_id, "mode": "vfs", "path": path}


@router.get("/api/v1/agent/context")
async def get_browser_context(connection_id: Optional[str] = None):
    """Return the UI's data-context snapshot for a connection.

    Default target: the active connection (same selection rule as
    ``/agent/navigate/entity``). When ``connection_id`` is supplied,
    return that exact connection's context — or 404 if it isn't open.

    Response:
        {ok: true, connection_id, context: { CurrentProjectTypeId: "...", ... }}
    """
    if connection_id:
        info = get_connection_infos().get(connection_id)
        if info is None:
            return _error(
                404,
                "CONNECTION_NOT_FOUND",
                f"Connection not found: {connection_id}",
            )
        return {
            "ok": True,
            "connection_id": connection_id,
            "context": await _with_project_path(info.browser_context or {}),
        }

    active = get_active_connection_info()
    if active is None:
        return _error(409, "NO_ACTIVE_TAB", "No active tab")
    cid, info = active
    return {
        "ok": True,
        "connection_id": cid,
        "context": await _with_project_path(info.browser_context or {}),
    }
