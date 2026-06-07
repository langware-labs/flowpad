"""Shared Prompt-entity helpers — create/dedup/scope machinery used by every
path that mints a library Prompt from raw text: pin-from-history
(``app/actions/prompt_pin_action.py``) and conversation send-prompt
(``app/actions/notification_action.py``).
"""
from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from flow_sdk.builtin.prompt import Prompt

#: Max length of the auto-derived prompt name (first line of the text).
_AUTO_NAME_MAX = 40


def normalize_prompt_text(text: str) -> str:
    """Whitespace-collapsed comparison key — the FE pin-state check must use
    the same normalization (see ``useLibraryPromptsForProject``)."""
    return " ".join(text.split())


def auto_prompt_name(text: str, fallback: str = "Pinned prompt") -> str:
    """First non-empty line, truncated to ~40 chars."""
    first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    if not first_line:
        return fallback
    if len(first_line) <= _AUTO_NAME_MAX:
        return first_line
    return first_line[: _AUTO_NAME_MAX - 1].rstrip() + "…"


async def project_prompts(project_id: Optional[str]) -> list["Prompt"]:
    """All library prompts in the given project scope (None → user scope)."""
    from flow_sdk.builtin.prompt import Prompt  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter  # noqa: PLC0415

    if project_id:
        return await Prompt.get_all(entities_filter=QueryFilter(match=ExpressionNode(project_id=project_id)))
    # Unscoped: match both NULL and '' (filter in Python — IS_NULL misses '').
    return [p for p in await Prompt.get_all() if not p.project_id]


async def scope_prompt_to_project(prompt: "Prompt", project_id: str) -> None:
    """Pre-compute the project-scoped asset_ref before save.

    Callers whose request URL targets a different entity than the project
    (pin-prompt targets a process; add_message targets a conversation) would
    fall back to user_home — resolve the project mount and let the canonical
    ``_prepare_for_storage`` compute the asset_ref under ``<project>/prompts/``
    exactly like the UI's project-scoped create (``POST /graph/project/<id>/prompt``).
    """
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    project = await Project.get_by_id(project_id)
    mount = getattr(project, "fs_storage_mount_path", None) if project else None
    if not mount:
        return
    await prompt._prepare_for_storage(Path(mount))


async def find_or_create_prompt(
    text: str,
    *,
    project_id: Optional[str],
    name: Optional[str] = None,
) -> "Prompt":
    """Find a scope-local Prompt with the same normalized text, or create one.

    The single mint path for text→Prompt: dedup by ``normalize_prompt_text``
    within the project scope (None → user scope), auto-name from the first
    line unless ``name`` overrides, project-scoped asset_ref when scoped.
    Never bumps ``use_count`` — usage is an execute-time event.
    """
    from flow_sdk.builtin.prompt import Prompt  # noqa: PLC0415

    normalized = normalize_prompt_text(text)
    existing = next(
        (p for p in await project_prompts(project_id) if normalize_prompt_text(p.text or "") == normalized),
        None,
    )
    if existing is not None:
        return existing
    prompt = Prompt(
        name=(name or auto_prompt_name(text)).strip(),
        text=text,
        project_id=project_id,
    )
    if project_id:
        await scope_prompt_to_project(prompt, project_id)
    await prompt.save()
    return prompt
