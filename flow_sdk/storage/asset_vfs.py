"""Entity adapter for a filesystem asset's VFS layout."""
from pathlib import Path

from flow_sdk.assets.vfs import LocalAssetVFSBinding, asset_vfs_binding
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def local_asset_vfs_binding(entity) -> LocalAssetVFSBinding | None:
    info = SchemaRegistry.get(entity.get_type())
    path = getattr(entity, "asset_ref", None)
    if info is None or not path:
        return None
    if info.git_publishable:
        return asset_vfs_binding(Path(path), info)
    if info.files_in_asset_folder:
        # No folder on disk yet (a received row before install, a deleted
        # folder) → the caller's embedded fallback, never an error.
        try:
            return asset_vfs_binding(Path(path), info)
        except (OSError, ValueError):
            return None
    return None
