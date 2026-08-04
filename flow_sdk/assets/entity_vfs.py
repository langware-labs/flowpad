"""Local entity-VFS binding for opted-in file-backed assets."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from flow_sdk.fs_store.schema_registry import SchemaRegistry


@dataclass(frozen=True)
class LocalAssetVFSBinding:
    """Entity-relative view over an asset's existing desktop checkout."""

    root: Path
    main_ref: str


def local_asset_vfs_binding(entity) -> LocalAssetVFSBinding | None:
    """Map a Git-publishable entity to its local VFS root and main file.

    This is the desktop half of the same entity-VFS contract the Hub binds to
    Git. It carries no Git behavior: it only replaces absolute compute-node refs
    with stable paths relative to the asset entity.
    """

    info = SchemaRegistry.get(entity.get_type())
    raw_asset_ref = getattr(entity, "asset_ref", None)
    if info is None or not info.git_publishable or not raw_asset_ref:
        return None

    asset_ref = Path(raw_asset_ref)
    if info.main_layout == "folder":
        root = info.folder_for(asset_ref)
        if not info.main_file:
            return None
        main_ref = info.main_file
    elif info.main_layout == "file":
        root = asset_ref.parent
        main_ref = asset_ref.name
    else:
        return None

    resolved_root = root.resolve(strict=True)
    resolved_main = (resolved_root / main_ref).resolve(strict=True)
    if not resolved_main.is_relative_to(resolved_root):
        raise ValueError("Asset main file escapes its entity VFS root")
    if not resolved_main.is_file():
        raise ValueError("Asset main file is unavailable")
    return LocalAssetVFSBinding(root=resolved_root, main_ref=main_ref)


__all__ = ["LocalAssetVFSBinding", "local_asset_vfs_binding"]
