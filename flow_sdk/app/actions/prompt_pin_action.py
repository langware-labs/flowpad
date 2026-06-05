"""HTTP endpoints for pinning a conversation-history prompt into the library.

The terminal's per-process prompt history (PromptIndexPanel) carries a pin
button per item: pin = create a library ``Prompt`` from that item's text and
mutually cross-link the Prompt and its ``AgenticProcess`` into each other's
PRIVATE context entities (``builtin/prompt_cross_link.py``); unpin = remove
the link AND remove the prompt from the library (entity row + backing .md).

Wire shape:

  POST /api/v1/graph/agentic_process/<id>/pin-prompt
  Body: {"text": "<history item text>", "name"?: "<override>"}
  →     {"prompt_id": ..., "prompt_type": "prompt", "pinned": true}

  POST /api/v1/graph/agentic_process/<id>/unpin-prompt
  Body: {"prompt_id": "<id>"}
  →     {"pinned": false}

Dedup is by whitespace-normalized text within the process's project scope —
pinning the same history item twice reuses the existing Prompt (idempotent).
"""
from __future__ import annotations

import logging
from json import JSONDecodeError
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.prompt import Prompt
from flow_sdk.builtin.prompt_cross_link import (
    cross_link_prompt_to_process,
    remove_prompt_process_link,
)
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

#: Max length of the auto-derived prompt name (first line of the text).
_AUTO_NAME_MAX = 40


def normalize_prompt_text(text: str) -> str:
    """Whitespace-collapsed comparison key — the FE pin-state check must use
    the same normalization (see ``useLibraryPromptsForProject``)."""
    return " ".join(text.split())


def _auto_name(text: str) -> str:
    first_line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    if not first_line:
        return "Pinned prompt"
    if len(first_line) <= _AUTO_NAME_MAX:
        return first_line
    return first_line[: _AUTO_NAME_MAX - 1].rstrip() + "…"


async def _resolve_process() -> AgenticProcess:
    """Load the URL-targeted AgenticProcess via the request context."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="pin-prompt: target typeid required")
    proc = await request_info.get_target_entity()
    if proc is None or not isinstance(proc, AgenticProcess):
        raise HTTPException(status_code=404, detail="pin-prompt: agentic process not found")
    return proc


async def _post_body() -> dict[str, Any]:
    request_info = get_current_request_info()
    try:
        return await request_info.get_post_data() or {}
    except JSONDecodeError:
        return {}


async def _project_prompts(project_id: Optional[str]) -> list[Prompt]:
    """All library prompts in the given project scope (None → user scope)."""
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter  # noqa: PLC0415

    if project_id:
        return await Prompt.get_all(entities_filter=QueryFilter(match=ExpressionNode(project_id=project_id)))
    # Unscoped: match both NULL and '' (filter in Python — IS_NULL misses '').
    return [p for p in await Prompt.get_all() if not p.project_id]


async def _scope_prompt_to_project(prompt: Prompt, project_id: str) -> None:
    """Pre-compute the project-scoped asset_ref before save.

    The action URL targets the *process*, so the request-context scope would
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


@action.post(action_name="pin-prompt", types="agentic_process")
async def pin_prompt() -> ApiResponse:
    """Create (or reuse) a library Prompt from a history item's text and
    cross-link it with the target process. Idempotent by normalized text."""
    proc = await _resolve_process()
    body = await _post_body()
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="pin-prompt: non-empty 'text' required")
    name_override = body.get("name")
    if name_override is not None and not isinstance(name_override, str):
        raise HTTPException(status_code=400, detail="pin-prompt: 'name' must be a string")

    project_id = proc.project_id or None
    normalized = normalize_prompt_text(text)
    existing = next(
        (p for p in await _project_prompts(project_id) if normalize_prompt_text(p.text or "") == normalized),
        None,
    )
    if existing is not None:
        prompt = existing
    else:
        prompt = Prompt(
            name=(name_override or _auto_name(text)).strip(),
            text=text,
            project_id=project_id,
        )
        if project_id:
            await _scope_prompt_to_project(prompt, project_id)
        await prompt.save()

    await cross_link_prompt_to_process(prompt, proc)
    return ApiSuccessResponse(
        data={"prompt_id": prompt.id, "prompt_type": Prompt.get_type(), "pinned": True}
    )


@action.post(action_name="unpin-prompt", types="agentic_process")
async def unpin_prompt() -> ApiResponse:
    """Remove the prompt↔process link and delete the Prompt from the library
    (entity row + record shadow + the backing .md, so a reindex can't
    resurrect it). Idempotent — an already-gone prompt is a no-op."""
    proc = await _resolve_process()
    body = await _post_body()
    prompt_id = body.get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id:
        raise HTTPException(status_code=400, detail="unpin-prompt: 'prompt_id' required")

    prompt = await Prompt.get_by_id(prompt_id)
    if prompt is None:
        return ApiSuccessResponse(data={"pinned": False, "prompt_id": prompt_id})

    await remove_prompt_process_link(prompt, proc)

    # Remove the backing .md first — Entity.destroy() purges the row + record
    # shadow but deliberately leaves asset files; here "unpin" means the
    # prompt leaves the library entirely.
    asset_ref = getattr(prompt, "asset_ref", None)
    if asset_ref:
        try:
            Path(asset_ref).unlink(missing_ok=True)
        except OSError:
            logger.warning("unpin-prompt: failed to remove %s", asset_ref)
    await prompt.destroy()
    return ApiSuccessResponse(data={"pinned": False, "prompt_id": prompt_id})
