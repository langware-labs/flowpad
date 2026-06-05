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
from typing import Any

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.prompt import Prompt
from flow_sdk.builtin.prompt_cross_link import (
    cross_link_prompt_to_process,
    remove_prompt_process_link,
)
from flow_sdk.builtin.prompt_helpers import find_or_create_prompt, normalize_prompt_text
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

__all__ = ["normalize_prompt_text"]  # re-export — FE contract docs point here


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

    prompt = await find_or_create_prompt(
        text, project_id=proc.project_id or None, name=name_override
    )
    await cross_link_prompt_to_process(prompt, proc)
    return ApiSuccessResponse(
        data={"prompt_id": prompt.id, "prompt_type": Prompt.get_type(), "pinned": True}
    )


@action.post(action_name="link-executed-prompt", types="agentic_process")
async def link_executed_prompt() -> ApiResponse:
    """Record that this process executed a library prompt: mutual private
    cross-link (same continuity as pin-from-history) + usage bump.

    Body: {"prompt_id": "<id>"}. Called by the conversation Approve & Execute
    flow after the headless run is triggered. Idempotent on the link; the
    usage counter increments on every call (each call = one execution).
    """
    proc = await _resolve_process()
    body = await _post_body()
    prompt_id = body.get("prompt_id")
    if not isinstance(prompt_id, str) or not prompt_id:
        raise HTTPException(status_code=400, detail="link-executed-prompt: 'prompt_id' required")

    prompt = await Prompt.get_by_id(prompt_id)
    if prompt is None:
        return ApiSuccessResponse(data={"linked": False, "prompt_id": prompt_id})

    await cross_link_prompt_to_process(prompt, proc)
    from datetime import datetime, timezone  # noqa: PLC0415

    prompt.use_count = (prompt.use_count or 0) + 1
    prompt.last_used_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    await prompt.save()
    return ApiSuccessResponse(
        data={"linked": True, "prompt_id": prompt_id, "use_count": prompt.use_count}
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
