"""The generated per-process ``opencode.json``.

OpenCode has no ``--add-dir``, so this file is how a process's generated
instruction assets and materialized skills reach the worker. It is written into
the process shadow dir (machine-generated launch config, not user-visible
content) and pointed at with ``OPENCODE_CONFIG``, which opencode merges between
the global and project configs.

Deliberately minimal: opencode resolves OpenRouter from a bare
``OPENROUTER_API_KEY`` in the spawn environment, so **no provider block and no
credential ever goes in this file**. It also rejects unknown top-level keys with
``ConfigInvalidError``, so only documented keys appear here.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

CONFIG_SCHEMA_URL = "https://opencode.ai/config.json"
CONFIG_FILENAME = "opencode.json"

# opencode discovers skills from any directory listed in ``skills.paths`` by
# scanning recursively for ``**/SKILL.md``. Laying them under ``.opencode/skills``
# inside the process assets dir keeps the on-disk shape recognisable to a human
# reading the process folder.
SKILLS_SUBDIR = Path(".opencode") / "skills"


def opencode_config_path_for_process(process_id: str) -> Path:
    """Where this process's generated config lives."""
    from flow_sdk.fs_store.record_paths import shadow_dir_for

    directory = shadow_dir_for("agentic_process", process_id) / "opencode"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / CONFIG_FILENAME


def build_config(
    *,
    instruction_files: list[str] | None = None,
    skill_paths: list[str] | None = None,
    plugin_files: list[str] | None = None,
    mcp: dict | None = None,
) -> dict:
    """The config body — pure, so it can be asserted on without touching disk."""
    config: dict = {"$schema": CONFIG_SCHEMA_URL}
    instructions = [str(p) for p in (instruction_files or []) if p]
    if instructions:
        config["instructions"] = instructions
    paths = [str(p) for p in (skill_paths or []) if p]
    if paths:
        config["skills"] = {"paths": paths}
    # ``plugin`` entries must be URLs, not bare paths: opencode resolves a bare
    # string as an npm module specifier and fails to load it.
    plugins = [Path(p).as_uri() for p in (plugin_files or []) if p]
    if plugins:
        config["plugin"] = plugins
    # The process's attached MCP servers. opencode's own shape (``type``
    # local/remote, ``command`` as an ARRAY, ``environment``) is built by
    # ``mcp_projection.to_opencode_mcp`` — never the ``mcpServers`` shape the
    # other vendors take.
    if mcp:
        config["mcp"] = dict(mcp)
    return config


def write_process_config(
    process_id: str,
    *,
    instruction_files: list[str] | None = None,
    skill_paths: list[str] | None = None,
    plugin_files: list[str] | None = None,
    mcp: dict | None = None,
) -> Path | None:
    """Write the generated config; return its path, or None when there is
    nothing to say (no instructions, no skills and no MCP — then the CLI's own
    config resolution is left completely alone)."""
    config = build_config(
        instruction_files=instruction_files,
        skill_paths=skill_paths,
        plugin_files=plugin_files,
        mcp=mcp,
    )
    if len(config) == 1:  # only the $schema key
        return None
    path = opencode_config_path_for_process(process_id)
    try:
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    except OSError:
        logger.debug("opencode: failed writing generated config at %s", path, exc_info=True)
        return None
    return path


def config_for_assets_dir(
    process_id: str,
    assets_dir: "Path | str | None",
    mcp: dict | None = None,
) -> Path | None:
    """Generate this process's config from a FlowPad instruction-assets dir.

    The ONE generator. Both spawn paths (the driver's headless turn and the
    shared prompt path's instruction context) come through here, so the policy
    for which files get listed lives in exactly one place.

    ``instructions`` entries are read eagerly by opencode, so a listed path that
    is not there aborts the whole turn with ``BadResource: FileSystem.readFile``
    before any model call — hence the existence checks rather than blind listing.
    """
    directory = Path(assets_dir) if assets_dir else None
    if directory is None or not str(directory):
        # MCP servers alone still warrant a config — a process can have
        # attached servers and no instruction assets at all.
        return write_process_config(process_id, mcp=mcp) if mcp else None
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.hook_plugin import plugin_path

    agents_md = directory / "AGENTS.md"
    skills_dir = directory / SKILLS_SUBDIR
    hook_plugin = plugin_path(directory)
    try:
        return write_process_config(
            process_id,
            instruction_files=[str(agents_md)] if agents_md.is_file() else [],
            skill_paths=[str(skills_dir)] if skills_dir.is_dir() else [],
            plugin_files=[str(hook_plugin)] if hook_plugin.is_file() else [],
            mcp=mcp,
        )
    except Exception:
        logger.debug("opencode: config generation failed for %s", process_id, exc_info=True)
        return None
