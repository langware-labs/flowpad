"""Entity adapter for a filesystem asset's VFS layout."""
from pathlib import Path

from flow_sdk.assets.vfs import LocalAssetVFSBinding, asset_vfs_binding
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def local_asset_vfs_binding(entity) -> LocalAssetVFSBinding | None:
    info = SchemaRegistry.get(entity.get_type())
    path = getattr(entity, "asset_ref", None)
    if info is None or not info.git_publishable or not path:
        return None
    return asset_vfs_binding(Path(path), info)
