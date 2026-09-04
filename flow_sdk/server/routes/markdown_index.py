"""MarkdownIndex JSON endpoint — serves the canonical structured form."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from flow_sdk.fs_store.operations.markdown_index_render import load_index_md_json

logger = logging.getLogger(__name__)
router = APIRouter()


def _json_for_folder(folder: Path) -> dict:
    """Return parsed sidecar in the frontend apiClient `{status, data}` envelope.

    A folder with no sidecar answers ``data: None``, NOT 404. "This folder has not
    been indexed yet" is an ordinary, expected answer to "is there an index?" — the
    caller (``MarkdownIndexPanel``) already treats it as the empty state rather than
    an error. Sending it as an HTTP error status made the browser log
    ``Failed to load resource: 404`` for every un-indexed folder a user opens, before
    any application code could run, so no client-side handling could suppress it.
    4xx stays for input that is actually wrong.
    """
    sidecar = folder / "index.md.json"
    parsed = load_index_md_json(sidecar)
    return {
        "status": "SUCCESS",
        "message": "success",
        "data": parsed.model_dump() if parsed is not None else None,
    }


@router.get("/markdown-index/json")
async def get_index_json_by_folder(folder: str = Query(...)) -> dict:
    """Return ``<folder>/index.md.json`` parsed. 404 when sidecar is missing."""
    return _json_for_folder(Path(folder))


@router.get("/markdown-index/{entity_id}/json")
async def get_index_json_by_entity(entity_id: str) -> dict:
    """Resolve the MarkdownIndex entity and return its sidecar JSON."""
    from flow_sdk.builtin.markdown_index import MarkdownIndex
    entity = await MarkdownIndex.get(entity_id)
    if entity is None:
        raise HTTPException(status_code=404, detail=f"Entity not found: {entity_id}")
    asset_ref = getattr(entity, "asset_ref", None)
    if not asset_ref:
        raise HTTPException(status_code=404, detail="Entity has no asset_ref")
    return _json_for_folder(Path(asset_ref).parent)
