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


def _markdown_vaults() -> list[dict]:
    """Enumerate markdown vault roots for the Wiki folder tree.

    Each entry carries (typeid, relPath, absPath, label, scope, project_id)
    so the UI can filter vaults against the active scope/project filter the
    same way records are filtered. typeid is always `compute_node-@local` —
    every scan root is reachable via the local compute node's VFS.
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_records.markdown_record import _doc_search_dirs  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    home = get_instance_settings().user_home.resolve()
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
        scope, project_id, label = _classify_vault(p, home)
        vaults.append({
            "typeid": "compute_node-@local",
            "relPath": rel_path,
            "label": label,
            "absPath": abs_path,
            "scope": scope,
            "project_id": project_id,
        })
    return vaults


def _classify_vault(p: Path, home: Path) -> tuple[str, str | None, str]:
    """Return ``(scope, project_id, label)`` for a vault root path.

    User vault → label "User docs". Project vault → label is
    "Project docs (<name>)" where <name> is the last segment of the
    project mount path; project_id is the synthetic uuid5 that records
    under it carry. Other dirs (env-supplied) → label is
    "Workspace docs (<dir>)", scope falls back to "user".
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    name = p.name
    parent_name = p.parent.name if p.parent else ""

    if name == "docs" and parent_name == ".claude":
        if p.parent == home / ".claude":
            return ("user", None, "User docs")
        project_mount = p.parent.parent if p.parent and p.parent.parent else None
        if project_mount is not None:
            project_name = project_mount.name or str(project_mount)
            return ("project", Project.derive_id_for_path(str(project_mount)), f"Project docs ({project_name})")

    if name == "docs":
        project_mount = p.parent if p.parent else None
        if project_mount is not None:
            project_name = project_mount.name or "docs"
            return ("project", Project.derive_id_for_path(str(project_mount)), f"Project docs ({project_name})")

    return ("user", None, f"Workspace docs ({name})" if name else "Workspace docs")


@router.get("/api/v1/assets/types")
async def get_asset_types():
    """Return all record types marked as browseable=True."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    types = [{"type_name": "project", "label": "Projects", "icon": None, "creatable": False}]
    for type_name in SchemaRegistry.get_all_types():
        ti = SchemaRegistry.get(type_name)
        if ti and ti.browseable:
            entry: dict = {
                "type_name": ti.type_name,
                "label": ti.type_name.replace("_", " ").title(),
                "icon": ti.icon,
                "creatable": ti.creatable,
            }
            if ti.type_name == "markdown":
                entry["vaults"] = _markdown_vaults()
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
