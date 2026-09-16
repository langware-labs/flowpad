"""Filesystem discovery primitives for worker-owned asset inventories.

The indexer's scope is every recognizable asset. A worker's scope is the
locations its harness loads. Drivers declare those locations; these helpers
do not infer availability from an entity's owner or its presence in the DB.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType


class AssetSearchRoot(DataSpec):
    asset_type: EntityType
    path: Path
    recursive: bool = False

    def asset_paths(self) -> list[Path]:
        """Return existing carriers, following links without walking cycles.

        Skill entities address the containing directory; subagents address
        their markdown file. A DB row or a yaml-only skill is not a carrier
        that a harness can load.
        """
        from flow_sdk.assets.folder import AssetFolder

        assets = AssetFolder(path=self.path, recursive=self.recursive).assets()
        return list(dict.fromkeys(asset.resolved_path for asset in assets
                                  if asset.typeid.type == self.asset_type.value
                                  and (self.asset_type != EntityType.SKILL or (asset.path / "SKILL.md").is_file())))


def project_ancestors(workdir: str | Path) -> list[Path]:
    """CWD through its nearest git worktree root (including .git files).

    Outside a worktree only CWD is a repository scope. Global roots are
    supplied separately by the driver, never by scanning the whole home.
    """
    cwd = Path(workdir).resolve()
    ancestors = [cwd, *cwd.parents]
    for index, directory in enumerate(ancestors):
        if (directory / ".git").exists():
            return ancestors[: index + 1]
    return [cwd]


def discover_asset_paths(roots: list[AssetSearchRoot]) -> dict[EntityType, set[str]]:
    """Canonical paths by type, independent of indexer state and UI mode."""
    paths: dict[EntityType, set[str]] = {}
    for root in dict.fromkeys(roots):
        paths.setdefault(root.asset_type, set()).update(str(path) for path in root.asset_paths())
    return paths
