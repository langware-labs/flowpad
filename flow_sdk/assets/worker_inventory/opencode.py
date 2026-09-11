"""OpenCode inventory uses the same mount projection as worker launches."""

import asyncio
import json
from collections.abc import Sequence
from fnmatch import fnmatchcase
from pathlib import Path
from tempfile import TemporaryDirectory

from flow_sdk.assets.asset_inventory import (
    AssetInventoryError,
    InventoryInputs,
    WorkerAsset,
    inventory_spawn,
    json_command,
    skill_observations,
)
from flow_sdk.schema.types import EntityType

_inventory_lock = asyncio.Lock()


def permitted(config: dict, agent: dict, tool: str, name: str) -> bool:
    """OpenCode's ordered permission rules: the final matching rule wins."""
    if agent.get("tools", {}).get(tool, config.get("tools", {}).get(tool)) is False:
        return False
    action = "allow"
    for settings in (config.get("permission", {}), agent.get("permission", {})):
        if isinstance(settings, str):
            action = settings
            continue
        for permission, rules in settings.items():
            if not fnmatchcase(tool, permission):
                continue
            if isinstance(rules, str):
                action = rules
            else:
                for pattern, value in rules.items():
                    if fnmatchcase(name, pattern):
                        action = value
    return action != "deny"


async def available_assets(inputs: InventoryInputs):
    # Native discovery initializes the same user store for every inputs.
    async with _inventory_lock:
        return await _available_assets(inputs)


async def _available_assets(inputs):
    argv, env = inventory_spawn(inputs, ["opencode", "debug", "skill"])
    paths = inputs.skill_paths
    # The read must never regenerate the live inputs's config: doing that
    # without its MCP/provider fragments would erase launch configuration.
    with TemporaryDirectory(prefix="flowpad-inventory-") as directory:
        if paths:
            config = Path(directory) / "opencode.json"
            config.write_text(json.dumps({"skills": {"paths": paths}}), encoding="utf-8")
            env["OPENCODE_CONFIG"] = str(config)
        # Both debug commands initialize OpenCode's SQLite store. Concurrent
        # startup demonstrably fails with "database is locked"; one probe must
        # finish initialization before the next opens that same store.
        response = await json_command(argv, cwd=inputs.workdir, env=env)
        config = await json_command([argv[0], "debug", "config"], cwd=inputs.workdir, env=env)
    if not isinstance(response, list):
        raise AssetInventoryError("OpenCode did not return a skill inventory")
    selected = inputs.agent or config.get("default_agent") or "build"
    agents = config.get("agent", {})
    agent = agents.get(selected, {})
    result = [asset for asset in skill_observations(response, path_key="location")
              if permitted(config, agent, "skill", asset.name)]
    for root in inputs.roots:
        if root.asset_type != EntityType.SUBAGENT:
            continue
        for path in root.asset_paths():
            name = path.relative_to(root.path.resolve()).with_suffix("").as_posix()
            definition = agents.get(name)
            if (definition is not None and not definition.get("disable")
                    and definition.get("mode") != "primary" and permitted(config, agent, "task", name)):
                result.append(WorkerAsset(asset_type=EntityType.SUBAGENT, name=name, path=path))
    return result


SKILLS_SUBDIR = Path(".opencode") / "skills"


def add_dir_contributions(add_dirs: "Sequence[str | Path] | None") -> tuple[list[str], list[str]]:
    """``(instruction_files, skill_paths)`` contributed by mounted roots.

    Every other vendor receives these roots as ``--add-dir``; opencode has no
    such flag, so without this they are carried to the argv builder and dropped
    — which is why ``load_flowpad_assistant`` and a project's context folders
    never reached an opencode worker.

    What goes on ``skills.paths`` is each CONTAINER of skill folders, never the
    root — measured against opencode 1.18.25: a config listing a root whose
    skills live in ``<root>/.claude/skills/<name>/`` finds NOTHING, while
    listing ``<root>/.claude/skills`` finds all of them. Its recursive scan does
    not descend into dot-directories, which is exactly where every harness keeps
    its skills. A root that holds skill folders directly is listed as-is.

    ``AGENTS.md`` at a root is added when it exists — opencode reads
    ``instructions`` entries eagerly and a missing file aborts the whole turn
    with ``BadResource`` before any model call.

    Results are de-duplicated in order: callers pass the process assets dir
    alongside ``resolved_add_dirs``, which already contains it.
    """
    from flow_sdk.assets.types.skill import folder_is_skill  # noqa: PLC0415
    from flow_sdk.fs_store.placement import WORKER_PREFIX  # noqa: PLC0415

    # Where a harness keeps skills inside a mounted root. Derived from the ONE
    # harness->dot-dir map so a fifth vendor (or a moved prefix) is picked up
    # here automatically; one mount may serve several vendors.
    containers = [
        SKILLS_SUBDIR,
        *(Path(prefix) / "skills" for prefix in sorted(set(WORKER_PREFIX.values()))),
        Path("skills"),
    ]
    instructions: list[str] = []
    skills: list[str] = []
    for raw in add_dirs or []:
        if not raw:
            continue
        directory = Path(raw)
        try:
            if not directory.is_dir():
                continue
            found_container = False
            for relative in containers:
                container = directory / relative
                if container.is_dir():
                    skills.append(str(container))
                    found_container = True
            # A root that IS a skills container rather than one that holds a
            # harness dot-dir. Checked only when no container matched: a root
            # with ``.claude/skills`` practically never also holds bare skills,
            # and this scan is the expensive one.
            if not found_container and any(
                folder_is_skill(child) for child in directory.iterdir() if child.is_dir()
            ):
                skills.append(str(directory))
            agents_md = directory / "AGENTS.md"
            if agents_md.is_file():
                instructions.append(str(agents_md))
        except OSError:
            continue
    return list(dict.fromkeys(instructions)), list(dict.fromkeys(skills))
