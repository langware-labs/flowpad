"""Read-only worker inventory transport and file-backed asset observations.

Inventory commands never send a user prompt or run an LLM turn. Discovery
failures are errors, not evidence that the worker has no available assets.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import Field

from flow_sdk.assets.asset_discovery import AssetSearchRoot
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType


class AssetInventoryError(RuntimeError):
    pass


def inventory_rows(response: dict, key: str) -> list[dict]:
    """A missing or malformed inventory is not proof of an empty inventory."""
    rows = response.get(key) if isinstance(response, dict) else None
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise AssetInventoryError(f"Worker did not return a valid {key} inventory")
    return rows


class WorkerAsset(DataSpec):
    asset_type: EntityType
    name: str
    path: Path


def skill_observations(rows: list[dict], *, path_key: str) -> list[WorkerAsset]:
    """Normalize native skill paths; virtual built-ins have no asset carrier."""
    assets = []
    for row in rows:
        if row.get("enabled") is False:
            continue
        raw_path, name = row.get(path_key), row.get("name")
        if not isinstance(raw_path, str) or not isinstance(name, str):
            continue
        path = Path(raw_path)
        # OpenCode's <built-in> marker is not relative to the process CWD.
        if not path.is_absolute():
            continue
        folder = path.parent if path.name == "SKILL.md" else path
        if (folder / "SKILL.md").is_file():
            assets.append(WorkerAsset(asset_type=EntityType.SKILL, name=name, path=folder.resolve()))
    return assets


class InventoryInputs(DataSpec):
    workdir: str
    executable: str
    env: dict[str, str]
    roots: list[AssetSearchRoot] = Field(default_factory=list)
    add_dirs: list[str] = Field(default_factory=list)
    plugin_dirs: list[str] = Field(default_factory=list)
    settings_json: dict = Field(default_factory=dict)
    agents_json: dict = Field(default_factory=dict)
    json_stream: bool = False
    no_auto_update: bool = False
    agent: str | None = None
    claude_home: Path | None = None
    skill_paths: list[str] = Field(default_factory=list)
