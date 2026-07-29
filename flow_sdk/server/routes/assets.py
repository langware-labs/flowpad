"""Assets route — type catalog and folder-prefix entity lookup.

Endpoints:
- ``GET /api/v1/assets/types``    — registered user-asset entity types.
- ``GET /api/v1/assets/by-path``  — entities whose ``asset_ref`` lives under
  one or more folders. Thin wrapper over ``Entity.assets_by_path``.
"""

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

router = APIRouter()


async def _markdown_vaults() -> list[dict]:
    """Enumerate markdown vault roots for the Wiki folder tree.

    Each entry carries (typeid, relPath, absPath, label, scope, project_id)
    so the UI can filter vaults against the active scope/project filter the
    same way records are filtered. typeid is always `compute_node-@local` —
    every scan root is reachable via the local compute node's VFS.

    A **project** vault is rooted at the project's mount path — the whole
    project, NOT just its ``docs/`` subfolder — so the menu walks every ``.md``
    in the project (gitignore-aware, via ``walk_markdown_files``). This is why a
    project-root file like ``streams_sdk.md`` shows up alongside ``docs/`` files.
    The single **user** vault stays the user-level ``.claude/docs`` knowledge dir.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    seen: set[str] = set()
    vaults: list[dict] = []

    def _add(abs_path: str, *, scope: str, project_id: str | None,
             record_project_id: str | None, label: str) -> None:
        try:
            resolved = str(Path(abs_path).resolve())
        except OSError:
            return
        if resolved in seen or not Path(resolved).is_dir():
            return
        seen.add(resolved)
        vaults.append({
            "typeid": "compute_node-@local",
            "relPath": resolved.lstrip("/"),
            "label": label,
            "absPath": resolved,
            "scope": scope,
            "project_id": project_id,
            "record_project_id": record_project_id,
        })

    # User vault — the user-level knowledge dir (~/.claude/docs).
    user_docs = get_instance_settings().claude_docs_dir
    _add(str(user_docs), scope="user", project_id=None,
         record_project_id=None, label="User docs")

    # One vault per project, rooted at the project ROOT (mount path).
    for proj in await Project.get_all():
        mount = getattr(proj, "fs_storage_mount_path", None)
        if not mount:
            continue
        name = Path(mount).name or str(mount)
        record_project_id = Project.derive_id_for_path(str(mount))
        entity_id = str(getattr(proj, "id", "") or "") or record_project_id
        _add(str(mount), scope="project", project_id=entity_id,
             record_project_id=record_project_id, label=f"Project docs ({name})")

    return vaults


@router.get("/api/v1/assets/types")
async def get_asset_types():
    """Return all record types with a non-null ``browseable_by`` view mode.

    The server can't know the client's current view mode, so it returns every
    browseable type along with its ``browseable_by`` level; the client filters
    by the active mode (cumulative — see ``use-asset-types.ts``).
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    types = [
        {"type_name": "project", "label": "Projects", "icon": None, "creatable": False,
         "browseable_by": "standard"}
    ]
    for type_name in SchemaRegistry.get_all_types():
        ti = SchemaRegistry.get(type_name)
        if ti and ti.browseable_by is not None:
            entry: dict = {
                "type_name": ti.type_name,
                "label": ti.type_name.replace("_", " ").title(),
                "icon": ti.icon,
                "creatable": ti.creatable,
                "browseable_by": ti.browseable_by.value,
            }
            if ti.type_name == "markdown":
                entry["vaults"] = await _markdown_vaults()
            types.append(entry)
    return JSONResponse(content={"status": "SUCCESS", "data": {"types": types}})


@router.get("/api/v1/assets/markdown-files")
async def list_markdown_files(
    root: str = Query(..., description="Absolute filesystem path of the vault root to walk."),
):
    """Walk a vault root for every ``.md`` file, honoring ``.gitignore``.

    Powers the Markdown asset menu's folder tree. Returns the COMPLETE set of
    markdown files under ``root`` (relative POSIX paths), so a project-root file
    like ``streams_sdk.md`` is included — not just files under ``docs/``. The
    walk reuses the indexer's gitignore matcher (``_WALK_IGNORED`` fast-path,
    ``.claude/`` force-include, last-match-wins ``.gitignore`` stack).
    """
    from flow_sdk.fs_store.operations.markdown_dirs import walk_markdown_files  # noqa: PLC0415

    root_path = Path(root)
    if not root_path.is_dir():
        return JSONResponse(
            content={"status": "SUCCESS", "data": {"files": []}},
        )
    files = walk_markdown_files(root_path)
    return JSONResponse(content={"status": "SUCCESS", "data": {"files": files}})


@router.get("/api/v1/assets/by-path")
async def list_entities_by_path(
    folder: list[str] = Query(
        ..., description="One or more folder paths; results are union of strict descendants."
    ),
    record_type: Optional[list[str]] = Query(
        default=None, description="Filter to these entity types. Omit for all types."
    ),
    limit: int = Query(default=200, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
    include_system: bool = Query(default=False),
):
    """List entities whose ``asset_ref`` lives under any of ``folder``.

    Half-open ``[<dir>/, <dir>0)`` lex range against
    ``json_extract(data, '$.asset_ref')``. The dir itself is **not** included
    — only strict descendants. Multi-folder = union; multi-type = ``IN``.
    """
    from flow_sdk.core.entity.entity_model import Entity, PathQueryOptions  # noqa: PLC0415

    entities = await Entity.assets_by_path(PathQueryOptions(
        search_dirs=list(folder),
        types=list(record_type) if record_type else None,
        include_system=include_system,
        limit=limit,
        offset=offset,
    ))

    return JSONResponse(content={"status": "SUCCESS", "data": {
        "search_dirs": list(folder),
        "types": list(record_type) if record_type else None,
        "entities": [{
            "id": e.id,
            "type": e.type or e.get_type(),
            "name": getattr(e, "name", "") or getattr(e, "uname", "") or "",
            "asset_ref": getattr(e, "asset_ref", "") or "",
            "scope": getattr(e, "scope", "") or "",
            "remote": bool(getattr(e, "remote", False)),
            "modified_at": str(getattr(e, "updated_date", "") or ""),
        } for e in entities],
        "limit": limit,
        "offset": offset,
    }})


@router.get("/api/v1/assets/entity")
async def get_entity_by_path(
    path: str = Query(..., description="Exact asset_ref (file path) of the entity to resolve."),
):
    """Resolve the single entity whose ``asset_ref`` equals ``path``.

    Pure DB lookup across every file-backed type (thin wrapper over
    ``Entity.get_by_asset_ref``) — **no discovery, no recovery scan, no
    indexing**. Exact match wins; on a miss, a file inside a folder-backed
    asset (skill, whiteboard, task, ...) resolves to its owning folder entity
    (deepest ancestor ``asset_ref`` — still a pure indexed DB lookup). Returns
    the full entity row, or ``null`` when no entity owns the path (caller
    keeps its fallback). This is the cheap, best-effort path→entity conversion
    the loader uses; ``/fs-records/{type}/discover`` is the heavy recovery
    counterpart and stays out of the hot path.
    """
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    entity = await Entity.get_by_asset_ref(path, resolve_containing=True)
    return JSONResponse(content={"status": "SUCCESS", "data": (
        entity.model_dump(mode="json") if entity is not None else None
    )})
