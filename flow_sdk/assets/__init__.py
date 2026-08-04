"""Portable, storage-neutral contracts for file-backed Flowpad assets."""

from flow_sdk.assets.entity_vfs import LocalAssetVFSBinding, local_asset_vfs_binding
from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.projection import (
    PORTABLE_ASSET_CONTRACT_VERSION,
    PortableAssetLayout,
    PortableAssetProjection,
    layout_for_origin,
    project_asset_tree,
)

__all__ = [
    "PORTABLE_ASSET_CONTRACT_VERSION",
    "PortableAssetLayout",
    "PortableAssetProjection",
    "LocalAssetVFSBinding",
    "PortableGitOrigin",
    "local_asset_vfs_binding",
    "layout_for_origin",
    "project_asset_tree",
]
