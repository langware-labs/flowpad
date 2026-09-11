"""Filesystem layout of an asset's relative VFS view."""
from pathlib import Path

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.layout import Folder


class LocalAssetVFSBinding(DataSpec):
    model_config = ConfigDict(frozen=True)
    """Entity-relative view over an asset's existing desktop checkout."""

    root: Path
    main_ref: str


def asset_vfs_binding(path: Path, info) -> LocalAssetVFSBinding | None:
    layout = info.layout_of(path)
    if layout.body is None:
        return None
    root = layout.root if isinstance(info.shape, Folder) else layout.body.parent
    main_ref = layout.body.name

    resolved_root = root.resolve(strict=True)
    resolved_main = (resolved_root / main_ref).resolve(strict=True)
    if not resolved_main.is_relative_to(resolved_root):
        raise ValueError("Asset main file escapes its entity VFS root")
    if not resolved_main.is_file():
        raise ValueError("Asset main file is unavailable")
    return LocalAssetVFSBinding(root=resolved_root, main_ref=main_ref)
