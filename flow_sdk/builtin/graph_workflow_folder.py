"""Application scope selection and persistence around shared graph scaffolds."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.core import Entity

logger = logging.getLogger(__name__)

def scaffold_graph_workflow_folder(
    entity: "Entity", home_dir: Path, fallback_slug: str
) -> Path:
    """Create the folder + stub files for a fresh folder-doc entity (idempotent).

    Sets ``entity.asset_ref`` to the resolved folder and pins the entity id in
    the ``.flow`` capsule so the indexer adopts it.
    """
    from flow_sdk.assets.creation import ensure_asset_scaffold, folder_slug
    from flow_sdk.assets.types.graph_workflow_doc import GraphWorkflowDoc

    folder = Path(entity.asset_ref) if entity.asset_ref else home_dir / folder_slug(entity.name, fallback_slug)
    folder = ensure_asset_scaffold(folder, entity.typeid, GraphWorkflowDoc(name=entity.name or ""))
    entity.asset_ref = str(folder)
    return folder



async def rescaffold_after_save(entity: "Entity", label: str) -> None:
    """The post-save scaffold dance shared by every folder-doc entity: ensure
    the folder exists, and re-persist ONLY when the scaffold just minted the
    folder path (fresh entity) — steady-state saves stay a single DB write."""
    try:
        prev_ref = entity.asset_ref
        entity.materialize_folder()
        if entity.asset_ref != prev_ref:
            await entity.update()
    except Exception:
        logger.exception("%s: folder scaffold failed", label)
