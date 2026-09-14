"""Resolve Claude's native command inventory back to file-backed skills."""

import json
from pathlib import Path

from flow_sdk.assets.asset_discovery import AssetSearchRoot
from flow_sdk.assets.asset_inventory import (
    WorkerAsset,
)
from flow_sdk.assets.frontmatter import _extract_frontmatter, _yaml_load
from flow_sdk.schema.types import EntityType


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def plugin_asset_roots(inputs, asset_type: EntityType) -> list[tuple[AssetSearchRoot, str]]:
    """Candidate carriers only. Native initialization decides what's enabled."""
    registry = _read_json(inputs.claude_home / "plugins/installed_plugins.json")
    directories: list[tuple[Path, str]] = []
    cwd = Path(inputs.workdir).resolve()
    for key, installs in registry.get("plugins", {}).items():
        for install in installs if isinstance(installs, list) else []:
            project = install.get("projectPath")
            if project and Path(project).resolve() not in (cwd, *cwd.parents):
                continue
            if install.get("installPath"):
                directories.append((Path(install["installPath"]), key.split("@", 1)[0]))
    directories.extend((Path(path), "") for path in inputs.plugin_dirs)
    roots = []
    family = "skills" if asset_type == EntityType.SKILL else "agents"
    for directory, fallback_name in directories:
        manifest = _read_json(directory / ".claude-plugin/plugin.json")
        name = manifest.get("name") or fallback_name
        if not name:
            continue
        configured = manifest.get(family, [])
        if isinstance(configured, str):
            configured = [configured]
        paths = [directory / family, *(directory / path for path in configured if isinstance(path, str))]
        roots.extend((AssetSearchRoot(asset_type=asset_type, path=path, recursive=True), name) for path in paths)
    return roots


def resolve_skills(inputs, commands: list[dict]) -> list[WorkerAsset]:
    native = {row["name"]: row for row in commands if isinstance(row.get("name"), str)}
    roots = [(root, "") for root in inputs.roots
             if root.asset_type == EntityType.SKILL]
    roots.extend(plugin_asset_roots(inputs, EntityType.SKILL))
    winners = {}
    for root, namespace in roots:
        for path in root.asset_paths():
            try:
                fields = _yaml_load(_extract_frontmatter((path / "SKILL.md").read_text(encoding="utf-8")) or "")
            except (OSError, ValueError):
                continue
            name = fields.get("name") or path.name
            native_name = f"{namespace}:{name}" if namespace else name
            if native_name in native and native_name not in winners:
                winners[native_name] = WorkerAsset(asset_type=EntityType.SKILL, name=native_name, path=path)
    return list(winners.values())


def resolve_subagents(inputs, agents: list[dict]) -> list[WorkerAsset]:
    native = {row["name"] for row in agents if isinstance(row.get("name"), str)}
    # CLI personas override filesystem agents. They already have an embedded or
    # inline descriptor, and must not make a shadowed project file look active.
    native.difference_update(inputs.agents_json or {})
    roots = [root for root in inputs.roots if root.asset_type == EntityType.SUBAGENT]
    personal = inputs.claude_home / "agents"
    roots.sort(key=lambda root: root.path == personal)
    candidates = [(root, "") for root in roots]
    candidates.extend(plugin_asset_roots(inputs, EntityType.SUBAGENT))
    winners = {}
    for root, namespace in candidates:
        for path in root.asset_paths():
            fields = _yaml_load(_extract_frontmatter(path.read_text(encoding="utf-8")) or "")
            name = fields.get("name") or path.stem
            native_name = f"{namespace}:{name}" if namespace else name
            if native_name in native and native_name not in winners:
                winners[native_name] = WorkerAsset(asset_type=EntityType.SUBAGENT, name=native_name, path=path)
    return list(winners.values())
