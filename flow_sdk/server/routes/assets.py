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
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.operations.markdown_dirs import doc_search_dirs as _doc_search_dirs  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    home = get_instance_settings().user_home.resolve()
    project_by_cwd = {
        canonical_posix_path(p.fs_storage_mount_path): p
        for p in await Project.get_all()
        if getattr(p, "fs_storage_mount_path", None)
    }
    seen: set[str] = set()
    vaults: list[dict] = []
    for raw in _doc_search_dirs():
        try:
            abs_path = str(raw.resolve())
        except OSError:
            continue
        if abs_path in seen:
            continue
        seen.add(abs_path)
        p = Path(abs_path)
        rel_path = abs_path.lstrip("/")
        scope, project_id, record_project_id, label = _classify_vault(p, home, project_by_cwd)
        vaults.append({
            "typeid": "compute_node-@local",
            "relPath": rel_path,
            "label": label,
            "absPath": abs_path,
            "scope": scope,
            "project_id": project_id,
            "record_project_id": record_project_id,
        })
    return vaults


def _classify_vault(p: Path, home: Path, project_by_cwd: dict[str, object]) -> tuple[str, str | None, str | None, str]:
    """Return ``(scope, project_id, record_project_id, label)`` for a vault root path.

    User vault → label "User docs". Project vault → label is
    "Project docs (<name>)" where <name> is the last segment of the
    project mount path; project_id is the Project entity id when resolvable,
    and record_project_id is the legacy uuid5 id records may carry.
    Other dirs (env-supplied) → label is
    "Workspace docs (<dir>)", scope falls back to "user".
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415

    name = p.name
    parent_name = p.parent.name if p.parent else ""

    def project_ids(project_mount: Path) -> tuple[str | None, str | None]:
        record_project_id = Project.derive_id_for_path(str(project_mount))
        proj = project_by_cwd.get(canonical_posix_path(project_mount))
        entity_id = str(getattr(proj, "id", "") or "") or record_project_id
        return entity_id, record_project_id

    if name == "docs" and parent_name == ".claude":
        if p.parent == home / ".claude":
            return ("user", None, None, "User docs")
        project_mount = p.parent.parent if p.parent and p.parent.parent else None
        if project_mount is not None:
            project_name = project_mount.name or str(project_mount)
            entity_id, record_project_id = project_ids(project_mount)
            return ("project", entity_id, record_project_id, f"Project docs ({project_name})")

    if name == "docs":
        project_mount = p.parent if p.parent else None
        if project_mount is not None:
            project_name = project_mount.name or "docs"
            entity_id, record_project_id = project_ids(project_mount)
            return ("project", entity_id, record_project_id, f"Project docs ({project_name})")

    return ("user", None, None, f"Workspace docs ({name})" if name else "Workspace docs")


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
                # Folder-layout types whose asset_ref is the bare folder expand
                # into their on-disk file tree in the sidebar (e.g. skill).
                "folder_backed": ti.folder_backed,
            }
            if ti.type_name == "markdown":
                entry["vaults"] = await _markdown_vaults()
            types.append(entry)
    return JSONResponse(content={"status": "SUCCESS", "data": {"types": types}})


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
    indexing**. Returns the full entity row, or ``null`` when no entity owns the
    path (caller keeps its fallback). This is the cheap, best-effort path→entity
    conversion the loader uses; ``/fs-records/{type}/discover`` is the heavy
    recovery counterpart and stays out of the hot path.
    """
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    entity = await Entity.get_by_asset_ref(path)
    return JSONResponse(content={"status": "SUCCESS", "data": (
        entity.model_dump(mode="json") if entity is not None else None
    )})
