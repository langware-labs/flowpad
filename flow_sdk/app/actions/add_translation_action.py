"""Document-translation action — register a translated copy of a markdown asset.

Wire shape::

    POST /api/v1/graph/<type>/<id>/add_translation
    Body: {"lang": "es", "process_id"?: "agentic_process-@<id>"}
    →     {"lang": "es",
           "ref": {"path": "...", "ref_type": "file", ...},
           "path": "<abs translations/es.md path>",
           "process_id": "agentic_process-@<id>" | null,
           "created": true}

A translation is an alternate body file of the SAME asset (not a separate
entity) — this action owns the two persisted mutations that MUST live in the
backend: creating the ``translations/<lang>.md`` placeholder under the asset's
record-data folder, and appending/updating the ``translations[]`` entry. It is
**idempotent by lang** — calling twice upserts the entry (used to attach the
launching worker's ``process_id`` on a second call).

It deliberately does NOT spawn the translator worker: launching a headless
skill worker (createProcess → attach skill → prompt) is the frontend's proven
seam (``runSkillWorker`` / ``useRunOnFile``). The frontend calls this action to
create the file + entry (getting back the exact path for the prompt), launches
the worker, then calls again with ``process_id`` to record it. Per-row status
("translating" vs "ready") is DERIVED from that process, never stored as state.
"""
from __future__ import annotations

import logging
from json import JSONDecodeError
from typing import Any

from fastapi import HTTPException

from flow_sdk.actions import action
from flow_sdk.builtin.claude_memory_entities import Markdown, Translation
from flow_sdk.fs_store.operations.translation import ensure_placeholder, normalize_lang
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


async def _resolve_markdown() -> Markdown:
    """Load the URL-targeted entity and assert it's a markdown-backed asset."""
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="add_translation: target typeid required")
    entity = await request_info.get_target_entity()
    if entity is None:
        raise HTTPException(status_code=404, detail="add_translation: asset not found")
    if not isinstance(entity, Markdown):
        raise HTTPException(
            status_code=400,
            detail=f"add_translation: {request_info.target_entity_typeid.type} is not a translatable markdown asset",
        )
    return entity


async def _post_body() -> dict[str, Any]:
    request_info = get_current_request_info()
    try:
        return (await request_info.get_post_data()) or {} if request_info else {}
    except JSONDecodeError:
        return {}


@action.post(action_name="add_translation", types="all")
async def add_translation() -> ApiResponse:
    """Create (or upsert) a translation entry + placeholder file for one lang.

    Idempotent by ``lang``: re-calling updates the existing entry's
    ``process_id`` rather than duplicating it. Returns the entry plus the
    absolute placeholder path (for the translator prompt) so the frontend never
    computes a records_data path.
    """
    entity = await _resolve_markdown()
    body = await _post_body()

    raw_lang = body.get("lang")
    if not isinstance(raw_lang, str) or not raw_lang.strip():
        raise HTTPException(status_code=400, detail="add_translation: non-empty 'lang' required")
    try:
        lang = normalize_lang(raw_lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"add_translation: {exc}") from exc

    process_id = body.get("process_id")
    if process_id is not None and not isinstance(process_id, str):
        raise HTTPException(status_code=400, detail="add_translation: 'process_id' must be a string")

    # Upsert by lang — the single writer of the translations[] array. The
    # frontend calls this twice per launch: first to create the entry + get the
    # ref back (for the translator prompt), then to attach the worker's
    # process_id. Only the create call touches the filesystem. (If the second
    # call is lost, the entry keeps process_id=null and simply reads as "ready"
    # once the worker's file lands — an acceptable orphan window, not a leak.)
    existing = next((t for t in entity.translations if t.lang == lang), None)
    created = existing is None
    if existing is not None:
        if process_id is not None:
            existing.process_id = process_id
        entry = existing
    else:
        ref = ensure_placeholder(entity.get_type(), str(entity.id), lang)
        entry = Translation(lang=lang, ref=ref, process_id=process_id)
        entity.translations.append(entry)

    await entity.save()

    return ApiSuccessResponse(
        data={
            "lang": entry.lang,
            "ref": entry.ref.to_dict(),
            "process_id": entry.process_id,
            "created": created,
        }
    )
