"""Authorize a selected destination and assign its application ownership."""
from pathlib import Path

from fastapi import HTTPException

from flow_sdk.assets.creation import destination_in
from flow_sdk.fs_store.type_id import TypeId


async def prepare_destination(entity, destination: dict, request_info):
    from flow_sdk.builtin.project import Project
    from flow_sdk.core import Entity
    from flow_sdk.storage import get_entity_storage

    info = entity.type_info
    if not info or not info.creatable or info.shape is None or not getattr(entity, "owns_asset_ref", True):
        raise ValueError("This type does not support a filesystem creation destination")
    if not isinstance(destination, dict) or destination.get("ref_type") != "folder":
        raise ValueError("destination must be a folder FSRef")
    if destination.get("read_only"):
        raise HTTPException(status_code=403, detail="Destination is read-only")
    if not destination.get("type_id") or not destination.get("path"):
        raise ValueError("Destination authority and path are required")
    authority = TypeId(destination["type_id"])
    if not request_info.su:
        if authority != request_info.target_entity_typeid or not request_info.auth_result:
            raise HTTPException(status_code=403, detail="Destination authority is outside this request")
        context = request_info.auth_context.model_copy(update={"action": "fs", "method": "post",
                                                               "direct_resource_type": None,
                                                               "sub_path": "write/" + destination["path"]})
        permission = request_info.policies.is_allowed_action(context, request_info.auth_result.target_roles)
        if not permission.allowed:
            raise HTTPException(status_code=403, detail="Destination is not writable")
    target = await Entity.get_by_typeid(authority)
    if target is None:
        raise ValueError("Destination authority does not exist")
    storage = get_entity_storage(authority, entity=target)
    resolver = getattr(storage, "_local_full_path", None)
    if not callable(resolver):
        raise ValueError("Destination storage does not support local asset creation")
    from flow_sdk.api.api_types.vfs_path import VFSPath
    vpath = VFSPath.from_entity_path(authority, destination["path"])
    folder = Path(resolver(vpath.abs_vfspath)).resolve()
    if not folder.is_relative_to(Path(storage.mount_path).resolve()):
        raise HTTPException(status_code=403, detail="Destination escapes its storage root")
    if folder.exists() and not folder.is_dir():
        raise ValueError("Destination must be a folder")
    name = getattr(entity, "name", None) or getattr(entity, "title", None) or ""
    path = destination_in(folder, info, name)
    projects = await Project.index_by_mount()
    owners = []
    for root, project in projects.items():
        resolved_root = Path(root).resolve()
        if path.is_relative_to(resolved_root):
            owners.append((resolved_root, project))
    owner = max(owners, key=lambda item: len(item[0].parts))[1] if owners else None
    entity.asset_ref = str(path)
    entity.project_id = str(owner.id) if owner is not None else None
    entity.parent_type_id = str(owner.typeid) if owner is not None else None
    if hasattr(entity, "parent_path"):
        entity.parent_path = str(path.parent)
    return owner
