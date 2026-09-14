"""Filesystem asset boundaries shared by editors and versioning callers."""
from pathlib import Path

from flow_sdk.schema.layout import Folder


def _folder_backed_types() -> list:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    return [info for name in SchemaRegistry.get_all_types()
            if (info := SchemaRegistry.get(name)) is not None
            and isinstance(info.shape, Folder) and info.shape.main and info.main_subdir]


def folder_asset_for(path: str | Path) -> tuple[Path, Path] | None:
    from flow_sdk.assets.asset import Asset
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    asset = Asset.containing(path)
    if asset is None:
        return None
    info = SchemaRegistry.get(asset.typeid.type)
    if not isinstance(info.shape, Folder) or not info.shape.main:
        return None
    # Versioning scopes only declared family placements; a repository-level
    # SKILL.md alone must not turn every unrelated file into a skill edit.
    family = Path(info.main_subdir).parts if info.main_subdir else ()
    if not family or asset.path.parent.parts[-len(family):] != family:
        return None
    return asset.path, asset.path / info.shape.main


def is_folder_asset_dir(path: str | Path) -> bool:
    found = folder_asset_for(path)
    return found is not None and found[0] == Path(path).resolve()
