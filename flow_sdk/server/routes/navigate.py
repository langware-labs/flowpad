"""Agent-driven navigation routes.

Exposes endpoints that let a local agent (invoked via the `flow navigate ...`
CLI) steer the UI in the user's browser tab.

Every route answers a ``NavigateResult`` (``flow_sdk.core.navigate``): the
target resolved, handed to the active (or named) browser tab as a ``ui_command``,
and probed — OK, NOT_YET (no browser open, or the page cannot be used yet),
NOT_FOUND, REFUSED. Only malformed input is an HTTP error.
"""

from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from flow_sdk.core.display_target import DisplayTargetKind, resolve_display_target
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.type_id import TypeId, is_named_id
from flow_sdk.responses.response import ApiSuccessResponse

from .websocket import (
    get_active_connection_info,
    get_connection_infos,
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


def _answer(result) -> ApiSuccessResponse:
    """Every OUTCOME is a ``NavigateResult`` in a success envelope — not found, no
    browser and a dead server included; only bad input is an HTTP error."""
    return ApiSuccessResponse(data=result.model_dump(mode="json"))


@router.post("/api/v1/agent/navigate/entity")
async def navigate_entity(req: NavigateEntityRequest):
    """Navigate the active (or named) browser tab to an entity's view; answers a
    ``NavigateResult`` (``flow_sdk.core.navigate``)."""
    from flow_sdk.core.navigate import show_target  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import NavigateResult  # noqa: PLC0415

    try:
        typeid = TypeId(req.typeid)
    except ValueError as e:
        return _error(400, "INVALID_TYPEID", f"Invalid typeid '{req.typeid}': {e}")
    if not typeid.id:
        return _error(400, "INVALID_TYPEID", f"Missing id in typeid '{req.typeid}'")
    if await _lookup_entity(typeid.type, typeid.id) is None:
        return _answer(NavigateResult.not_found(f"No {typeid.type} {typeid.id}.", verdict="not_found"))
    target = {"kind": DisplayTargetKind.ENTITY, "type": typeid.type, "id": typeid.id}
    return _answer(await show_target(target, connection_id=req.connection_id))


class NavigateFileRequest(BaseModel):
    """Body for POST /api/v1/agent/navigate/file.

    ``path`` is a filesystem path (absolute or ``~``-relative). ``connection_id``
    optionally targets a specific browser tab; omitted = the active tab.
    """

    path: str
    connection_id: Optional[str] = None


@router.post("/api/v1/agent/navigate/file")
async def navigate_file(req: NavigateFileRequest):
    """Navigate the active browser tab to a file by path — the indexed asset's own
    editor when an entity owns it, else a raw VFS open (``resolve_display_target``,
    ``discover=True``: a file an agent just wrote lands on its bespoke editor). A
    path with no file behind it answers ``NOT_FOUND``."""
    from flow_sdk.core.navigate import show_target  # noqa: PLC0415

    raw = (req.path or "").strip()
    if not raw:
        return _error(400, "INVALID_PATH", "Missing path")
    resolved = await resolve_display_target(path=raw, discover=True)
    return _answer(await show_target(resolved, connection_id=req.connection_id))


class NavigateViewRequest(BaseModel):
    """Body for POST /api/v1/agent/navigate/view.

    ``view`` is a dock address — ``<viewType>[/<pointer>][?<opts>]``, e.g.
    ``events``, ``assets/list/skill``, ``preferences/appearance``. This is the
    only navigate form that reaches a SCREEN rather than an entity or a file.
    """

    view: str
    connection_id: Optional[str] = None


@router.post("/api/v1/agent/navigate/view")
async def navigate_view(req: NavigateViewRequest):
    """Navigate the active browser tab to a dock address (a screen). Validated against
    the ``dock_address`` table first: a malformed address is a 400 the agent can act
    on; an entity-shaped pointer that names nothing answers ``NOT_FOUND``."""
    from flow_sdk.core.display_target import DisplayTargetNotFound, InvalidDisplayTarget  # noqa: PLC0415
    from flow_sdk.core.navigate import show_target  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import NavigateResult  # noqa: PLC0415

    raw = (req.view or "").strip()
    if not raw:
        return _error(400, "INVALID_VIEW", "Missing view")
    try:
        resolved = await resolve_display_target(dock=raw)
    except InvalidDisplayTarget as e:
        return _error(400, "INVALID_VIEW", str(e))
    except DisplayTargetNotFound as e:
        return _answer(NavigateResult.not_found(str(e), verdict="not_found"))
    return _answer(await show_target(resolved, connection_id=req.connection_id))


@router.get("/api/v1/agent/context")
async def get_browser_context(connection_id: Optional[str] = None):
    """Return the UI's data-context snapshot for a connection.

    Default target: the active connection (same selection rule as
    ``/agent/navigate/entity``). When ``connection_id`` is supplied,
    return that exact connection's context — or 404 if it isn't open.

    Response:
        {ok: true, connection_id, context: { CurrentProjectTypeId: "...", ... },
         here: { view, pointer, page, address, project, process, entity, last_shown }}
    """
    if connection_id:
        info = get_connection_infos().get(connection_id)
        if info is None:
            return _error(
                404,
                "CONNECTION_NOT_FOUND",
                f"Connection not found: {connection_id}",
            )
        return await _context_body(connection_id, info.browser_context or {})

    active = get_active_connection_info()
    if active is None:
        return _error(409, "NO_ACTIVE_TAB", "No active tab")
    cid, info = active
    return await _context_body(cid, info.browser_context or {})


async def _context_body(connection_id: str, ctx: dict) -> dict:
    """The raw slots, and ``here`` -- where the tab is, keeping only the context its screen
    provides (``flow_sdk.core.navigation.here_from``)."""
    from flow_sdk.core.navigation import here_from  # noqa: PLC0415

    return {
        "ok": True,
        "connection_id": connection_id,
        "context": await _with_project_path(ctx),
        "here": (await here_from(ctx)).model_dump(mode="json", exclude_none=True),
    }
