"""Filesystem asset utilities; public imports do not initialize application state."""
from importlib import import_module

_EXPORTS = {
    "Asset": "asset",
    "AssetFolder": "folder",
    "PORTABLE_ASSET_CONTRACT_VERSION": "projection",
    "PortableAssetLayout": "projection",
    "PortableAssetProjection": "projection",
    "PortableGitOrigin": "git_origin",
    "layout_for_origin": "projection",
    "read_asset_tree": "projection",
}
__all__ = list(_EXPORTS)


def __getattr__(name: str):
    module = _EXPORTS.get(name)
    if module is None:
        raise AttributeError(name)
    return getattr(import_module(f"flow_sdk.assets.{module}"), name)
