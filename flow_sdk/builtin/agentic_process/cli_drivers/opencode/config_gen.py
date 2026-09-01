"""The generated per-process ``opencode.json``.

OpenCode has no ``--add-dir``, so this file is how a process's generated
instruction assets and materialized skills reach the worker — AND how the extra
roots every other vendor gets as ``--add-dir`` (the Flowpad Assistant mount, a
project's context folders, ``additional_dirs``) get there. It is written into
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
from collections.abc import Sequence
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
    from flow_sdk.fs_store.indexer.functions.skill import folder_is_skill  # noqa: PLC0415
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
    body = json.dumps(config, indent=2) + "\n"
    try:
        # The shared prompt path regenerates this on every turn; rewriting
        # identical bytes only churns the mtime.
        if path.is_file() and path.read_text(encoding="utf-8") == body:
            return path
        path.write_text(body, encoding="utf-8")
    except OSError:
        logger.debug("opencode: failed writing generated config at %s", path, exc_info=True)
        return None
    return path


def config_for_assets_dir(
    process_id: str,
    assets_dir: "Path | str | None",
    mcp: dict | None = None,
    add_dirs: "Sequence[str | Path] | None" = None,
) -> Path | None:
    """Generate this process's config from a FlowPad instruction-assets dir.

    The ONE generator. Both spawn paths (the driver's headless turn and the
    shared prompt path's instruction context) come through here, so the policy
    for which files get listed lives in exactly one place.

    ``instructions`` entries are read eagerly by opencode, so a listed path that
    is not there aborts the whole turn with ``BadResource: FileSystem.readFile``
    before any model call — hence the existence checks rather than blind listing.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.opencode.hook_plugin import plugin_path

    directory = Path(assets_dir) if assets_dir and str(assets_dir) else None
    # The assets dir is just another mounted root to scan — and ``add_dirs``
    # (``resolved_add_dirs``) already contains it, hence the de-dup inside.
    roots: list[str | Path] = [directory] if directory is not None else []
    roots.extend(add_dirs or [])
    instructions, skills = add_dir_contributions(roots)
    hook_plugin = plugin_path(directory) if directory is not None else None
    try:
        return write_process_config(
            process_id,
            instruction_files=instructions,
            skill_paths=skills,
            plugin_files=[str(hook_plugin)] if hook_plugin and hook_plugin.is_file() else [],
            mcp=mcp,
        )
    except Exception:
        logger.debug("opencode: config generation failed for %s", process_id, exc_info=True)
        return None
