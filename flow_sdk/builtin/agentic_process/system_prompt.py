"""The one composer of a worker's system prompt — ordered layers, most general first.

Every turn path (headless driver, inline print-mode, PTY launch) reaches the
worker's system prompt through :func:`compose_layers` + :func:`render`, called
from ``ProcessAssets._prepare_system_instruction_assets``. Nothing else may add
standing text: a new standing instruction is a new :class:`LayerKey`, not a
side channel in a driver. See ``docs/agent/system-prompt-layers.md``.

Order (each layer present only when its scope applies and it has text):

==================  ===============================================================
``COMMON``          ``instructions/common.md`` — every process, SDK/CLI/backend/app
``COMMON_UI``       ``instructions/common_ui.md`` — ``launch_surface == "app"`` only
``INSTRUCTIONS``    ``context_data.instructions`` — agent ``system_prompt`` / caller
``IO``              ``context_data.io_instructions`` — typed run I/O
``ALWAYS_USE_SKILLS`` the project's ``always_use_skills`` directive
``COS_TASKS``       a Chief of Staff's open tasks, rebuilt every turn
``AGENTS``          persona / embedded agents (vibe.md, standard.md, wizards…)
``AUTO_OPEN``       what a vibe session's ``auto_open`` already showed
``LANGUAGE``        the project's ``# Language`` directive (non-English locale)
==================  ===============================================================
"""
from __future__ import annotations

import logging
from enum import StrEnum
from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.assets.document import read_document
from flow_sdk.config import flowpad_assistant_project_root
from flow_sdk.schema.data_spec.spec import DataSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

logger = logging.getLogger(__name__)

#: ``context_data[LAUNCH_SURFACE_KEY] == LAUNCH_SURFACE_APP`` marks a process the Flowpad app
#: launched. The UI stamps it through one TS seam (``ts_sdk/src/process/launch-surface.ts``);
#: SDK, CLI and backend launches never set it.
LAUNCH_SURFACE_KEY = "launch_surface"
LAUNCH_SURFACE_APP = "app"

#: Where the shipped layers live — inside the system project, so the wheel's
#: ``system_projects/**/*`` package-data glob ships them.
SHIPPED_INSTRUCTIONS_DIR = flowpad_assistant_project_root() / "instructions"


class LayerKey(StrEnum):
    COMMON = "common"
    COMMON_UI = "common_ui"
    INSTRUCTIONS = "instructions"
    IO = "io"
    ALWAYS_USE_SKILLS = "always_use_skills"
    COS_TASKS = "cos_tasks"
    AGENTS = "agents"
    AUTO_OPEN = "auto_open"
    LANGUAGE = "language"


class PromptLayer(DataSpec):
    key: LayerKey
    text: str


_shipped_cache: dict[Path, tuple[float, str]] = {}


def shipped_layer(name: str, root: Path | None = None) -> str:
    """``<root>/<name>.md``'s body (frontmatter and capsules stripped); ``""`` when missing or empty.

    Cached by mtime: this resolves on every headless turn.
    """
    path = (root or SHIPPED_INSTRUCTIONS_DIR) / f"{name}.md"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return ""
    cached = _shipped_cache.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        text = read_document(path).body.strip()
    except OSError:
        logger.warning("system prompt: cannot read %s", path, exc_info=True)
        return ""
    _shipped_cache[path] = (mtime, text)
    return text


def is_app_launch(context_data: dict | None) -> bool:
    return (context_data or {}).get(LAUNCH_SURFACE_KEY) == LAUNCH_SURFACE_APP


def launch_surface_fields(value: object) -> dict:
    """``{"launch_surface": "app"}`` for an app launch, else ``{}`` — to merge into ``context_data``.

    The one place a request's ``launch_surface`` becomes process state; any value
    but ``"app"`` is dropped, so a request can never invent another surface.
    """
    return {LAUNCH_SURFACE_KEY: LAUNCH_SURFACE_APP} if value == LAUNCH_SURFACE_APP else {}


async def _language_layer(process: "AgenticProcess") -> str:
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (  # noqa: PLC0415
        resolve_worker_language,
    )
    from flow_sdk.i18n.supported_locales import language_prompt_block  # noqa: PLC0415

    name = await resolve_worker_language(process)
    return language_prompt_block(name) if name else ""


async def compose_layers(process: "AgenticProcess", agents: dict | None = None) -> list[PromptLayer]:
    """The process's system-prompt layers, in order, empty ones dropped.

    ``agents`` is the embedded-agents JSON (name → spec) the ``AGENTS`` and
    ``AUTO_OPEN`` layers render from; without it they are empty.
    """
    from flow_sdk.builtin.agent_auto_open import auto_open_prompt_block  # noqa: PLC0415
    from flow_sdk.builtin.agentic_process.process_assets import (  # noqa: PLC0415
        VIBE_PERSONA_NAME,
        ProcessAssets,
    )

    data = process.context_data or {}
    agents = agents or {}
    chief = bool(data.get("chief_of_staff"))

    cos_tasks = ""
    if chief:
        from flow_sdk.tasks.cos import open_tasks_block  # noqa: PLC0415

        cos_tasks = await open_tasks_block(process)

    # A Chief of Staff's native roster is its staff, described in CoS.md and spawned with
    # the Agent tool — never the "execute it yourself" catalogue embedded agents get.
    agents_block = "" if chief else ProcessAssets._render_agents_instruction_block(agents, process.process_persona_path)
    auto_open = auto_open_prompt_block(data) if VIBE_PERSONA_NAME in agents else ""

    candidates = (
        (LayerKey.COMMON, shipped_layer("common")),
        (LayerKey.COMMON_UI, shipped_layer("common_ui") if is_app_launch(data) else ""),
        (LayerKey.INSTRUCTIONS, str(data.get("instructions") or "")),
        (LayerKey.IO, str(data.get("io_instructions") or "")),
        (LayerKey.ALWAYS_USE_SKILLS, process._resolve_always_use_skills_block()),
        (LayerKey.COS_TASKS, cos_tasks),
        (LayerKey.AGENTS, agents_block),
        (LayerKey.AUTO_OPEN, auto_open),
        (LayerKey.LANGUAGE, await _language_layer(process)),
    )
    stripped = ((key, text.strip()) for key, text in candidates)
    return [PromptLayer(key=key, text=text) for key, text in stripped if text]


def render(layers: list[PromptLayer]) -> str:
    return "\n\n".join(layer.text for layer in layers)
