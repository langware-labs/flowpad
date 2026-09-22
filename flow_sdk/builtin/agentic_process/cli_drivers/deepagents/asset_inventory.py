"""Deep Agents asset inventory.

The other vendors ask their CLI what it loaded. Here the loader is ours to read: the runner is
handed an explicit list of skills dirs and deepagents' skill middleware is a plain scan of
``<dir>/<name>/SKILL.md`` — so the inventory is that same scan over that same list, with no
subprocess to spawn.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.assets.asset_inventory import WorkerAsset, skill_observations


async def available_assets(options) -> list[WorkerAsset]:
    rows = [
        {"name": skill_md.parent.name, "path": str(skill_md)}
        for skills_dir in options._skills_dirs()
        for skill_md in sorted(Path(skills_dir).glob("*/SKILL.md"))
    ]
    return skill_observations(rows, path_key="path")
